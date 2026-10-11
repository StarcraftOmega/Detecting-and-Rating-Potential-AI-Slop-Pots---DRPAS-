const express = require("express");
const supabase = require("../config/supabase");

const router = express.Router();

router.get("/trusted-creator/:username", async (req, res) => {
    const username = typeof req.params.username === "string"
        ? decodeURIComponent(req.params.username).trim().slice(0, 500) : "";
    if (!username) return res.status(400).json({ error: "username is required" });

    try {
        const { data, error } = await supabase
            .from("score_snapshots")
            .select('\"Username\", trusted_creator_score')
            .ilike("Username", username)
            .order("calculated_at", { ascending: false })
            .limit(100);
        if (error) throw error;
        const matchingRows = Array.isArray(data) ? data : [];
        const trustedRow = matchingRows.find((row) =>
            Number(row?.trusted_creator_score) === 1);
        const selectedRow = trustedRow || matchingRows[0] || null;
        res.json({
            checked: true,
            username: selectedRow?.Username || username,
            trustedCreatorScore: trustedRow ? 1 :
                (typeof selectedRow?.trusted_creator_score === "number"
                    ? selectedRow.trusted_creator_score : null),
        });
    } catch (error) {
        console.error("Trusted creator lookup failed:", error.message);
        res.status(500).json({ error: "Failed to check trusted creator" });
    }
});

function readScoreInput(body) {
    const { platform, listingId, listingUrl, title, username, score, images } = body || {};
    if (typeof platform !== "string" || !platform.trim() ||
        typeof listingId !== "string" || !listingId.trim() ||
        !score || typeof score !== "object" || Array.isArray(score) ||
        !Array.isArray(images) || images.length > 100) {
        return { error: "platform, listingId, score, and up to 100 images are required" };
    }
    const numericFields = [
        "totalImageScore", "descriptionScore", "userReportsScore",
        "etsyReviewScore", "trustedCreatorScore", "aggregateScore"
    ];
    for (const field of numericFields) {
        if (score[field] !== undefined && score[field] !== null &&
            (typeof score[field] !== "number" || score[field] < 0 || score[field] > 1)) {
            return { error: `${field} must be a number between 0 and 1` };
        }
    }
    const validImages = images.map((image, index) => ({
        imageIndex: index + 1,
        imageHash: image?.imageHash,
        imageUrl: typeof image?.imageUrl === "string" ? image.imageUrl.slice(0, 2000) : null,
        aiScore: image?.aiScore,
        modelVersion: typeof image?.modelVersion === "string" ? image.modelVersion.slice(0, 80) : null
    }));
    if (validImages.some((image) =>
        typeof image.imageHash !== "string" || !image.imageHash ||
        typeof image.aiScore !== "number" || image.aiScore < 0 || image.aiScore > 1)) {
        return { error: "each image requires an imageHash and aiScore between 0 and 1" };
    }
    return {
        value: {
            platform: platform.trim(),
            listingId: listingId.trim(),
            listingUrl: typeof listingUrl === "string" ? listingUrl.slice(0, 2000) : null,
            title: typeof title === "string" ? title.slice(0, 500) : null,
            username: typeof username === "string" ? username.trim().slice(0, 500) : null,
            score,
            images: validImages
        }
    };
}

router.get("/:platform/:listingId", async (req, res) => {
    const { platform, listingId } = req.params;
    const username = typeof req.query.username === "string"
        ? req.query.username.trim().slice(0, 500) : "";

    try {
        const { data: pattern, error: patternError } = await supabase
            .from("patterns")
            .select("id, source_platform, external_listing_id, listing_url, title")
            .eq("source_platform", platform)
            .eq("external_listing_id", listingId)
            .maybeSingle();

        if (patternError) {
            throw patternError;
        }

        if (!pattern) {
            return res.status(404).json({ error: "Pattern not found" });
        }

        const { data: snapshot, error: snapshotError } = await supabase
            .from("score_snapshots")
            .select('id, "Username", total_image_score, description_score, user_reports_score, etsy_review_score, trusted_creator_score, aggregate_score, model_version, scoring_version, calculated_at, description_rationale')
            .eq("pattern_id", pattern.id)
            .order("calculated_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (snapshotError) {
            throw snapshotError;
        }

        if (!snapshot) {
            return res.status(404).json({ error: "Score not found" });
        }

        let trustedSnapshot = null;
        if (username) {
            const { data, error: trustedError } = await supabase
                .from("score_snapshots")
                .select('\"Username\", trusted_creator_score')
                .ilike("Username", username)
                .order("trusted_creator_score", { ascending: false, nullsFirst: false })
                .order("calculated_at", { ascending: false })
                .limit(1)
                .maybeSingle();
            if (trustedError) throw trustedError;
            trustedSnapshot = data;
        }

        const { data: images, error: imageError } = await supabase
            .from("image_analyses")
            .select("image_index, image_hash, ai_score, model_version, analyzed_at")
            .eq("snapshot_id", snapshot.id)
            .order("image_index", { ascending: true });

        if (imageError) {
            throw imageError;
        }

        res.json({
            pattern,
            score: {
                ...snapshot,
                ...(trustedSnapshot || {}),
                images: images || []
            }
        });
    } catch (error) {
        console.error("Score retrieval failed:", error.message);
        res.status(500).json({ error: "Failed to retrieve score" });
    }
});

router.post("/", async (req, res) => {
    const parsed = readScoreInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const input = parsed.value;
    try {
        const { data: pattern, error: patternError } = await supabase
            .from("patterns")
            .upsert({
                source_platform: input.platform,
                external_listing_id: input.listingId,
                listing_url: input.listingUrl,
                title: input.title
            }, { onConflict: "source_platform,external_listing_id" })
            .select("id, source_platform, external_listing_id, listing_url, title")
            .single();
        if (patternError) throw patternError;

        const { data: snapshot, error: snapshotError } = await supabase
            .from("score_snapshots")
            .insert({
                pattern_id: pattern.id,
                Username: input.username,
                total_image_score: input.score.totalImageScore ?? null,
                description_score: input.score.descriptionScore ?? null,
                user_reports_score: input.score.userReportsScore ?? null,
                etsy_review_score: input.score.etsyReviewScore ?? null,
                trusted_creator_score: input.score.trustedCreatorScore ?? null,
                aggregate_score: input.score.aggregateScore ?? null,
                description_rationale: typeof input.score.descriptionRationale === "string"
                    ? input.score.descriptionRationale.slice(0, 10000) : null,
                model_version: typeof input.score.modelVersion === "string"
                    ? input.score.modelVersion.slice(0, 80) : null,
                scoring_version: typeof input.score.scoringVersion === "string"
                    ? input.score.scoringVersion.slice(0, 80) : null
            })
            .select('id, "Username", aggregate_score, description_score, description_rationale, model_version, scoring_version, calculated_at')
            .single();
        if (snapshotError) throw snapshotError;

        if (input.images.length) {
            const { error: imagesError } = await supabase
                .from("image_analyses")
                .insert(input.images.map((image) => ({
                    snapshot_id: snapshot.id,
                    image_index: image.imageIndex,
                    image_url: image.imageUrl,
                    image_hash: image.imageHash,
                    ai_score: image.aiScore,
                    model_version: image.modelVersion
                })));
            if (imagesError) throw imagesError;
        }

        res.status(201).json({ pattern, score: snapshot, imageCount: input.images.length });
    } catch (error) {
        console.error("Score submission failed:", error.message);
        res.status(500).json({
            error: "Failed to save score",
            detail: error.message
        });
    }
});

module.exports = router;