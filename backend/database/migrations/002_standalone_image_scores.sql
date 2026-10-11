-- Hash-only image scores for feed and recommendation images.
-- Apply this migration to the deployed Supabase project.

CREATE TABLE IF NOT EXISTS public.standalone_image_scores (
    image_hash TEXT PRIMARY KEY,
    image_url TEXT,
    ai_score DOUBLE PRECISION NOT NULL CHECK (ai_score >= 0 AND ai_score <= 1),
    model_version TEXT,
    analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_standalone_image_scores_analyzed_at
ON public.standalone_image_scores(analyzed_at DESC);

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.standalone_image_scores
    TO anon, authenticated, service_role;

ALTER TABLE public.standalone_image_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS public_standalone_image_score_access ON public.standalone_image_scores;
CREATE POLICY public_standalone_image_score_access ON public.standalone_image_scores
    FOR ALL TO anon, authenticated
    USING (true)
    WITH CHECK (true);
