const STORAGE_KEY = "serverListingCache";
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function listingKey(platform, listingId) {
  if (typeof platform !== "string" || !platform.trim() ||
      typeof listingId !== "string" || !listingId.trim()) return null;
  return `${platform.trim().toLowerCase()}:${listingId.trim()}`;
}

export function isFresh(calculatedAt, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now()) {
  const time = Date.parse(calculatedAt || "");
  return Number.isFinite(time) && time <= now && now - time <= maxAgeMs;
}

export function normalizeServerScore(response) {
  const score = response?.score;
  if (!score || typeof score !== "object" || !isFresh(score.calculated_at)) return null;
  const descriptionScore = typeof score.description_score === "number" &&
    Number.isFinite(score.description_score) &&
    score.description_score >= 0 && score.description_score <= 1
    ? score.description_score
    : null;
  const images = Array.isArray(score.images) ? score.images.filter((image) =>
    typeof image?.image_hash === "string" &&
    Number.isFinite(Number(image.ai_score)) &&
    Number(image.ai_score) >= 0 && Number(image.ai_score) <= 1
  ) : [];
  return {
    overall: Number.isFinite(Number(score.aggregate_score)) ? Number(score.aggregate_score) : null,
    descriptionScore,
    descriptionRationale: typeof score.description_rationale === "string"
      ? score.description_rationale : "",
    trustedCreatorScore: typeof score.trusted_creator_score === "number"
      ? score.trusted_creator_score : null,
    username: typeof score.Username === "string" ? score.Username : "",
    calculatedAt: score.calculated_at,
    modelVersion: typeof score.model_version === "string" ? score.model_version : "server",
    images: images.map((image) => ({
      imageId: image.image_hash,
      score: Number(image.ai_score),
      modelVersion: image.model_version || score.model_version || "server",
      analyzedAt: image.analyzed_at || score.calculated_at,
    })),
    source: "server",
    serverSynced: true,
  };
}

export async function getCachedListing(key) {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY]?.[key] || null;
}

export async function cacheListing(key, value) {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...(stored[STORAGE_KEY] || {}), [key]: value },
  });
  return value;
}