
-- RATE THAT SLOP DATABASE SCHEMA

-- 1. USER PROFILES
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY
        REFERENCES auth.users(id) ON DELETE CASCADE,

    display_name TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- 2. SEWING PATTERNS
CREATE TABLE IF NOT EXISTS public.patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    source_platform TEXT NOT NULL,
    external_listing_id TEXT NOT NULL,
    listing_url TEXT,
    title TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (source_platform, external_listing_id)
);


-- 3. USER REPORTS
CREATE TABLE IF NOT EXISTS public.reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL
        REFERENCES public.profiles(id) ON DELETE CASCADE,

    pattern_id UUID NOT NULL
        REFERENCES public.patterns(id) ON DELETE CASCADE,

    pattern_tried BOOLEAN NOT NULL,
    garment_type TEXT,

    answers JSONB NOT NULL DEFAULT '{}'::jsonb,

    questionnaire_version INTEGER NOT NULL DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (user_id, pattern_id),

    CONSTRAINT valid_answers
        CHECK (jsonb_typeof(answers) = 'object'),

    CONSTRAINT valid_questionnaire_version
        CHECK (questionnaire_version > 0)
);


-- 4. SCORE SNAPSHOTS
CREATE TABLE IF NOT EXISTS public.score_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    pattern_id UUID NOT NULL
        REFERENCES public.patterns(id) ON DELETE CASCADE,

    total_image_score DOUBLE PRECISION,
    description_score DOUBLE PRECISION,
    user_reports_score DOUBLE PRECISION,
    etsy_review_score DOUBLE PRECISION,
    trusted_creator_score DOUBLE PRECISION,
    aggregate_score DOUBLE PRECISION,

    model_version TEXT,
    scoring_version TEXT,

    calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    description_rationale TEXT
);

ALTER TABLE public.score_snapshots
ADD COLUMN IF NOT EXISTS description_rationale TEXT;


-- 5. IMAGE ANALYSES
CREATE TABLE IF NOT EXISTS public.image_analyses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    snapshot_id UUID NOT NULL
        REFERENCES public.score_snapshots(id) ON DELETE CASCADE,

    image_index INTEGER NOT NULL
        CHECK (image_index BETWEEN 1 AND 100),

    image_url TEXT,
    image_hash TEXT,

    ai_score DOUBLE PRECISION NOT NULL,

    model_version TEXT,

    analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (snapshot_id, image_index)
);


-- 6. INDEXES
CREATE INDEX IF NOT EXISTS idx_reports_pattern_id
ON public.reports(pattern_id);

CREATE INDEX IF NOT EXISTS idx_score_snapshots_pattern
ON public.score_snapshots(pattern_id, calculated_at DESC);

CREATE INDEX IF NOT EXISTS idx_image_analyses_snapshot
ON public.image_analyses(snapshot_id);

-- Hash-only image results used by feed/recommendation images that are not
-- associated with a listing score.
CREATE TABLE IF NOT EXISTS public.standalone_image_scores (
    image_hash TEXT PRIMARY KEY,
    image_url TEXT,
    ai_score DOUBLE PRECISION NOT NULL CHECK (ai_score >= 0 AND ai_score <= 1),
    model_version TEXT,
    analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_standalone_image_scores_analyzed_at
ON public.standalone_image_scores(analyzed_at DESC);


-- 7. ROW LEVEL SECURITY
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.score_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.image_analyses ENABLE ROW LEVEL SECURITY;

-- Keep server writes available when the API uses the Supabase service_role key.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.patterns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reports TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.score_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.image_analyses TO service_role;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.standalone_image_scores TO service_role;

-- Score reads and writes are intentionally public for the hackathon demo.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.patterns TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.score_snapshots TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.image_analyses TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.standalone_image_scores TO anon, authenticated;

DROP POLICY IF EXISTS public_score_pattern_access ON public.patterns;
CREATE POLICY public_score_pattern_access ON public.patterns
    FOR ALL TO anon, authenticated
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS public_score_snapshot_access ON public.score_snapshots;
CREATE POLICY public_score_snapshot_access ON public.score_snapshots
    FOR ALL TO anon, authenticated
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS public_score_image_access ON public.image_analyses;
CREATE POLICY public_score_image_access ON public.image_analyses
    FOR ALL TO anon, authenticated
    USING (true)
    WITH CHECK (true);

ALTER TABLE public.standalone_image_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS public_standalone_image_score_access ON public.standalone_image_scores;
CREATE POLICY public_standalone_image_score_access ON public.standalone_image_scores
    FOR ALL TO anon, authenticated
    USING (true)
    WITH CHECK (true);

-- Auth signup does not automatically create a profile row. Reports depend on
-- that row, so create it transactionally whenever Supabase creates a user.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (id, display_name)
    VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data ->> 'display_name', NEW.email))
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

INSERT INTO public.profiles (id, display_name)
SELECT id, COALESCE(raw_user_meta_data ->> 'display_name', email)
FROM auth.users
ON CONFLICT (id) DO NOTHING;
