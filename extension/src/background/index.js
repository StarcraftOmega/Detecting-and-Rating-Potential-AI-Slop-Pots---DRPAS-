// Model orchestration service: owns the cache and forwards image requests to
// the offscreen document, where ONNX Runtime can decode and process images.
import { apiClient } from "./api-client.js";
import { checkSignInSetup, clearSession, getAccessToken, getSession, signInWithPassword, signUpWithPassword } from "./auth.js";
import { getSettings, isSettingEnabled, setSettings } from "./settings.js";
import { clearDiagnostics, clearLocalCache, readDiagnostics, writeDiagnostic } from "./diagnostics.js";
import {
  cacheListing,
  getCachedListing,
  isFresh,
  listingKey,
  normalizeServerScore,
} from "./listing-cache.js";

const OFFSCREEN_URL = "src/background/offscreen.html";
const MODEL_VERSION_FALLBACK = "unknown";
const CACHE_MAX = 3000;
const MAX_IMAGES = 100;
const CACHE_STORAGE_PREFIX = "inference:";
const POST_STORAGE_PREFIX = "post:";
const SCRAPING_ENABLED_KEY = "scrapingEnabled";
const cache = new Map();
const inflight = new Map();
const serverListingInflight = new Map();
let offscreenReady = null;
let modelManifestPromise = null;

async function modelManifest() {
  if (!modelManifestPromise) {
    modelManifestPromise = fetch(chrome.runtime.getURL("model_manifest.json"))
      .then((response) => {
        if (!response.ok) throw new Error(`model manifest fetch failed: ${response.status}`);
        return response.json();
      });
  }
  return modelManifestPromise;
}

function validateManifest(manifest) {
  const threshold = Number(manifest.threshold);
  if (!manifest.version || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("model manifest has invalid version or threshold");
  }
  return { ...manifest, threshold };
}

function cacheKeyFor(imageHash) {
  return `sha256:${imageHash}`;
}

async function hashImageInputs(imageUrl, imageData) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({
    kind: "aid:hash-image",
    imageUrl,
    imageData,
  });
  if (!response?.ok || typeof response.imageId !== "string" || !response.imageId) {
    throw new Error(response?.error || "image hashing failed");
  }
  return response.imageId;
}

async function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: ["WORKERS"],
          justification: "Runs local ONNX image inference without uploading images.",
        });
      }
    })().catch((error) => {
      offscreenReady = null;
      throw error;
    });
  }
  return offscreenReady;
}

async function cacheGet(key) {
  if (cache.has(key)) return cache.get(key);
  const stored = await chrome.storage.local.get(`${CACHE_STORAGE_PREFIX}${key}`);
  const value = stored[`${CACHE_STORAGE_PREFIX}${key}`];
  if (value) cache.set(key, value);
  return value;
}

async function cachePut(key, value) {
  if (cache.size >= CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
    await chrome.storage.local.remove(`${CACHE_STORAGE_PREFIX}${oldestKey}`);
  }
  cache.set(key, value);
  await chrome.storage.local.set({ [`${CACHE_STORAGE_PREFIX}${key}`]: value });
}

async function cachedResultsFor(imageUrls) {
  await ensureOffscreen();
  const hashResponse = await chrome.runtime.sendMessage({
    kind: "aid:hash-images",
    imageUrls,
  });
  if (!hashResponse?.ok) {
    throw new Error(hashResponse?.error || "image hashing failed");
  }
  const hashes = hashResponse.hashes || {};
  const keys = imageUrls.map((imageUrl) =>
    typeof hashes[imageUrl] === "string" ? cacheKeyFor(hashes[imageUrl]) : "",
  );
  const missingKeys = keys.filter((key) => !cache.has(key));
  if (missingKeys.length) {
    const stored = await chrome.storage.local.get(
      missingKeys.map((key) => `${CACHE_STORAGE_PREFIX}${key}`),
    );
    for (const key of missingKeys) {
      const value = stored[`${CACHE_STORAGE_PREFIX}${key}`];
      if (value) cache.set(key, value);
    }
  }
  const results = Object.fromEntries(
    imageUrls
      .map((imageUrl, index) => [imageUrl, {
        hash: hashes[imageUrl],
        result: cache.get(keys[index]),
      }])
      .filter(([, value]) => value.hash && value.result),
  );
  return { hashes, results };
}

async function analyze(message) {
  const imageUrl = typeof message.imageUrl === "string" ? message.imageUrl : "";
  const imageData = typeof message.imageData === "string" ? message.imageData : "";
  if (!imageUrl && !imageData) throw new Error("imageUrl or imageData is required");

  const imageHash = typeof message.imageHash === "string"
    ? message.imageHash
    : await hashImageInputs(imageUrl, imageData);
  const key = cacheKeyFor(imageHash);
  const manifest = validateManifest(await modelManifest());
  const serverResult = await serverImageResult(message, imageHash, manifest);
  if (serverResult) return serverResult;
  const cached = await cacheGet(key);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);

  const request = (async () => {
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({
      kind: "aid:infer",
      imageUrl,
      imageData,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "inference failed");
    }
    if (typeof response.imageId !== "string" || !response.imageId) {
      throw new Error("inference did not return an image hash");
    }
    const resultKey = cacheKeyFor(response.imageId);

    const threshold = Number(manifest.threshold ?? 0.65);
    const score = Number(response.score);
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error("inference returned an invalid probability");
    }
    const result = {
      score,
      label: score >= threshold ? "likely-ai" : "likely-real",
      threshold,
      modelVersion: manifest.version || MODEL_VERSION_FALLBACK,
      imageId: response.imageId,
      processingTimeMs: Number.isFinite(Number(response.processingTimeMs))
        ? Number(response.processingTimeMs)
        : 0,
    };
    await cachePut(resultKey, result);
    if (isSettingEnabled(await getSettings(), "serverUploadEnabled")) {
      await apiClient.submitImageScore({
        imageHash: response.imageId,
        imageUrl,
        aiScore: score,
        modelVersion: result.modelVersion,
      }).catch(async (error) => {
        await writeDiagnostic("image-score-upload-failed", { error: error.message });
      });
    }
    return result;
  })().finally(() => inflight.delete(key));

  inflight.set(key, request);
  return request;
}

async function serverListing(message) {
  if (!isSettingEnabled(await getSettings(), "serverInfoEnabled")) return null;
  const listingId = typeof message?.meta?.listingId === "string"
    ? message.meta.listingId : "";
  const username = typeof message?.meta?.username === "string"
    ? message.meta.username
    : typeof message?.meta?.seller === "string" ? message.meta.seller : "";
  if (!listingId) return null;
  const key = listingKey("etsy", listingId);
  if (!key) return null;
  const cached = await getCachedListing(key);
  if (cached?.calculatedAt && isFresh(cached.calculatedAt) && cached.serverSynced &&
      typeof cached.username === "string" && cached.username.trim() &&
      cached.username.trim().toLocaleLowerCase() === username.trim().toLocaleLowerCase()) {
    return cached;
  }
  if (serverListingInflight.has(key)) return serverListingInflight.get(key);

  const request = apiClient.getListingScore("etsy", listingId, username)
    .then((response) => normalizeServerScore(response))
    .then((score) => score ? cacheListing(key, score) : null)
    .catch(() => null)
    .finally(() => serverListingInflight.delete(key));
  serverListingInflight.set(key, request);
  return request;
}

async function serverImageResult(message, imageHash, manifest) {
  if (!isSettingEnabled(await getSettings(), "serverInfoEnabled")) return null;
  const listing = await serverListing(message);
  const listingImage = listing?.images.find((candidate) => candidate.imageId === imageHash);
  const image = listingImage || await apiClient.getImageScore(imageHash)
    .then((response) => response?.image || null)
    .catch(() => null);
  if (!image) return null;
  const threshold = Number(manifest.threshold ?? 0.65);
  return {
    score: Number(image.score ?? image.ai_score),
    label: Number(image.score ?? image.ai_score) >= threshold ? "likely-ai" : "likely-real",
    threshold,
    modelVersion: image.modelVersion || image.model_version || "server",
    imageId: image.imageId || image.image_hash,
    processingTimeMs: 0,
    source: "server",
    ...(listing ? { calculatedAt: listing.calculatedAt, listingRating: listing.overall } : {}),
  };
}

function compactAiRating(value) {
  if (!value || typeof value !== "object") return undefined;
  const score = Number(value.score ?? value.rating);
  if (!Number.isFinite(score) || score < 0 || score > 1) return undefined;
  const rating = { score };
  if (typeof value.label === "string") rating.label = value.label.slice(0, 80);
  if (typeof value.modelVersion === "string") {
    rating.modelVersion = value.modelVersion.slice(0, 80);
  }
  return rating;
}

function descriptionDetails(listing) {
  return {
    title: listing?.title || "",
    price: listing?.price || "",
    instructions: listing?.instructions || "",
    attributes: listing?.attributes || "",
  };
}

function compactDescriptionAssessment(value) {
  const score = Number(value?.ai_likeness_score);
  if (!Number.isInteger(score) || score < 0 || score > 100) return null;
  return {
    score: score / 100,
    percent: score,
    rationale: typeof value.overall_rationale === "string"
      ? value.overall_rationale.slice(0, 10000) : "",
    classification: typeof value.classification === "string"
      ? value.classification.slice(0, 80) : "",
  };
}

function imageAggregate(images) {
  const scores = images.map((image) => Number(image.aiScore))
    .filter((score) => Number.isFinite(score) && score >= 0 && score <= 1)
    .sort((a, b) => a - b);
  if (!scores.length) return null;
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const position = (scores.length - 1) * 0.9;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const highRisk = scores[lower] + (scores[upper] - scores[lower]) * (position - lower);
  return mean * 0.6 + highRisk * 0.4;
}

async function syncListingResult(message) {
  const listing = message?.listing;
  const listingId = typeof listing?.listingId === "string" ? listing.listingId : "";
  const images = Array.isArray(message?.images) ? message.images : [];
  if (!listingId || !images.length) return { ok: true, skipped: "incomplete" };
  const key = listingKey("etsy", listingId);
  const existing = key ? await getCachedListing(key) : null;
  if (existing?.calculatedAt && isFresh(existing.calculatedAt) &&
      existing.serverSynced && Array.isArray(existing.images) &&
      existing.images.length >= images.length &&
      (typeof listing?.description !== "string" || !listing.description.trim() ||
        typeof existing.descriptionScore === "number")) {
    return { ok: true, cached: true, score: existing };
  }
  const imageScore = imageAggregate(images);
  const settings = await getSettings();
  let description = null;
  if (isSettingEnabled(settings, "descriptionAiEnabled") && await getAccessToken() &&
      typeof listing.description === "string" && listing.description.trim()) {
    try {
      description = compactDescriptionAssessment(await apiClient.evaluateDescription(
        listing.description.trim(), descriptionDetails(listing),
      ));
    } catch (error) {
      await writeDiagnostic("description-upload-failed", { error: error.message });
      description = null;
    }
  }
  const aggregateScore = imageScore === null ? null
    : description ? (imageScore * 0.6 + description.score * 0.15) / 0.75 : imageScore;
  const localRecord = {
    overall: aggregateScore,
    descriptionScore: description?.score ?? null,
    descriptionRationale: description?.rationale || "",
    username: typeof listing.username === "string"
      ? listing.username
      : typeof listing.seller === "string" ? listing.seller : "",
    calculatedAt: new Date().toISOString(),
    modelVersion: images.find((image) => image.modelVersion)?.modelVersion || "local",
    images: images.map((image) => ({
      imageId: image.imageId,
      score: Number(image.aiScore),
      modelVersion: image.modelVersion || "local",
      analyzedAt: new Date().toISOString(),
    })),
    source: "local",
    serverSynced: false,
  };
  if (key) await cacheListing(key, localRecord);
  if (!await getAccessToken() || !isSettingEnabled(settings, "serverUploadEnabled")) {
    return { ok: true, cached: true, score: localRecord };
  }
  const response = await apiClient.submitListingScore({
    platform: "etsy",
    listingId,
    listingUrl: listing.pageUrl,
    title: listing.title,
    score: {
      totalImageScore: imageScore,
      descriptionScore: description?.score ?? null,
      aggregateScore,
      modelVersion: localRecord.modelVersion,
      scoringVersion: "1",
      descriptionRationale: description?.rationale || "",
    },
    images: images.map((image) => ({
      imageHash: image.imageId,
      imageUrl: image.url,
      aiScore: image.aiScore,
      modelVersion: image.modelVersion,
    })),
  });
  if (key) {
    const serverScore = normalizeServerScore(response);
    await cacheListing(key, {
      ...localRecord,
      ...(serverScore || {}),
      images: localRecord.images,
      serverSynced: true,
      source: "server",
    });
  }
  await writeDiagnostic("listing-score-uploaded", { listingId, imageCount: inputImageCount(images) });
  return { ok: true, score: response };
}

function inputImageCount(images) {
  return Array.isArray(images) ? images.length : 0;
}

async function scrapePost(message) {
  const post = message?.post;
  const identity = post?.identity;
  const listingId = typeof identity?.listingId === "string" ? identity.listingId : "";
  if (!listingId) throw new Error("listing identity is required");

  const settings = await getSettings();
  if (!settings.scrapingEnabled) return { ok: true, skipped: "disabled" };

  const storageKey = `${POST_STORAGE_PREFIX}${listingId}`;
  const existing = await chrome.storage.local.get(storageKey);

  const reviewsAndImages = settings.etsyReviewsEnabled
    ? post.reviewsAndImages
    : {
      ...post.reviewsAndImages,
      ratings: "",
      reviews: [],
      reviewImages: [],
    };
  const listingImages = Array.isArray(reviewsAndImages?.images)
      ? reviewsAndImages.images : [];
  const reviewImages = Array.isArray(reviewsAndImages?.reviewImages)
    ? reviewsAndImages.reviewImages : [];
  const images = [...listingImages, ...reviewImages]
      .map((image) => image?.url)
      .filter((url) => typeof url === "string" && /^https?:\/\//i.test(url))
  let imageIds = [];
  if (images.length) {
    await ensureOffscreen();
    const hashResponse = await chrome.runtime.sendMessage({
      kind: "aid:hash-images",
      imageUrls: [...new Set(images)].slice(0, MAX_IMAGES),
    });
    if (!hashResponse?.ok) throw new Error(hashResponse?.error || "image hashing failed");
    imageIds = Object.values(hashResponse.hashes || {})
      .filter((imageId) => typeof imageId === "string" && imageId);
  }

  const record = {
    listingId,
    creator: typeof identity.creator === "string" ? identity.creator.slice(0, 500) : "",
    price: typeof identity.price === "string" ? identity.price.slice(0, 120) : "",
    url: typeof identity.url === "string" ? identity.url.slice(0, 2000) : "",
    name: typeof identity.name === "string" ? identity.name.slice(0, 500) : "",
    imageIds: [...new Set(imageIds)],
    aiRating: compactAiRating(message.aiRating),
    scrapedAt: new Date().toISOString(),
  };
  if (existing[storageKey]) {
    const prior = existing[storageKey];
    if (prior.descriptionAssessment || prior.imageResults?.length) {
      return { ok: true, record: prior, skipped: "already-scraped" };
    }
  }
  await chrome.storage.local.set({ [storageKey]: record });
  return { ok: true, record };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind === "aid:configure-server") {
    const serverBaseUrl = typeof message.serverBaseUrl === "string"
      ? message.serverBaseUrl.trim().replace(/\/+$/, "") : "";
    if (!/^https:\/\/[^/]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(serverBaseUrl)) {
      sendResponse({ ok: false, error: "Use an HTTPS API URL or a localhost URL." });
      return false;
    }
    chrome.storage.local.set({ serverBaseUrl })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:sign-in") {
    signInWithPassword({ email: message.email, password: message.password })
      .then((result) => sendResponse({ ok: true, user: result.user }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:sign-up") {
    signUpWithPassword({ email: message.email, password: message.password })
      .then((result) => sendResponse({
        ok: true,
        user: result.user,
        requiresEmailConfirmation: result.requiresEmailConfirmation,
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:check-sign-in-setup") {
    chrome.storage.local.get("serverBaseUrl")
      .then((settings) => checkSignInSetup(settings.serverBaseUrl))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:get-auth-state") {
    getAccessToken()
      .then((token) => token ? getSession() : null)
      .then((session) => sendResponse({ ok: true, user: session?.user || null }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:sign-out") {
    clearSession()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:get-listing-score") {
    serverListing({ meta: {
      listingId: message.listingId,
      username: message.username,
    } })
      .then((score) => sendResponse({ ok: true, available: Boolean(score), score }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:get-trusted-creator") {
    getSettings().then(async (settings) => {
      if (!isSettingEnabled(settings, "serverInfoEnabled")) {
        throw new Error("shared server information is disabled in settings");
      }
      return apiClient.getTrustedCreator(message.username);
    })
      .then((assessment) => sendResponse({ ok: true, assessment }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:submit-score") {
    getSettings().then(async (settings) => {
      if (!isSettingEnabled(settings, "serverUploadEnabled")) {
        throw new Error("server uploads are disabled in settings");
      }
      if (!await getAccessToken()) {
        return { skipped: "not-signed-in" };
      }
      return apiClient.submitListingScore(message.payload).then(async (response) => {
        const payload = message.payload;
        const key = listingKey(payload.platform, payload.listingId);
        if (key) {
          const cached = await getCachedListing(key);
          const serverScore = normalizeServerScore(response);
          return cacheListing(key, {
            ...(cached || {}),
            ...(serverScore || {}),
            images: cached?.images || serverScore?.images || [],
            username: typeof payload.username === "string" ? payload.username : cached?.username || "",
            serverSynced: true,
            source: "server",
          });
        }
        return response;
      });
    })
      .then((score) => sendResponse({ ok: true, ...score }))
      .catch((error) => {
        writeDiagnostic("listing-score-upload-failed", { error: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  if (message?.kind === "aid:evaluate-description") {
    getSettings().then((settings) => {
      if (!isSettingEnabled(settings, "descriptionAiEnabled")) {
        throw new Error("AI description testing is disabled in settings");
      }
      return apiClient.evaluateDescription(message.description, message.listingDetails || {});
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:evaluate-reviews") {
    getSettings().then((settings) => {
      if (!isSettingEnabled(settings, "scrapingEnabled")) {
        throw new Error("Etsy scraping is disabled in settings");
      }
      if (!isSettingEnabled(settings, "etsyReviewsEnabled")) {
        throw new Error("Etsy reviews are disabled in settings");
      }
      return apiClient.evaluateReviews(message.reviewsAndImages);
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:scrape-post") {
    scrapePost(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:sync-listing") {
    syncListingResult(message)
      .then((result) => sendResponse(result))
      .catch((error) => {
        writeDiagnostic("listing-sync-failed", { error: error.message });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
  if (message?.kind === "aid:get-user-reviews") {
    getSettings().then((settings) => {
      if (!isSettingEnabled(settings, "userReviewsEnabled")) {
        throw new Error("user reviews are disabled in settings");
      }
      return apiClient.getUserReviews(message.platform || "etsy", message.listingId);
    })
      .then((reviews) => sendResponse({ ok: true, reviews }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:submit-user-review") {
    getSettings().then((settings) => {
      if (!isSettingEnabled(settings, "userReviewsEnabled") ||
          !isSettingEnabled(settings, "serverUploadEnabled")) {
        throw new Error("user review uploads are disabled in settings");
      }
      return apiClient.submitUserReview(message.payload);
    })
      .then((review) => sendResponse({ ok: true, review }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:get-settings") {
    getSettings().then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:set-settings") {
    setSettings(message.settings).then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:get-diagnostics") {
    readDiagnostics()
      .then((logs) => sendResponse({ ok: true, logs }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:run-server-diagnostics") {
    apiClient.runDiagnostics()
      .then((diagnostics) => sendResponse({ ok: true, diagnostics }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:clear-cache") {
    clearLocalCache()
      .then((removed) => sendResponse({ ok: true, removed }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:clear-diagnostics") {
    clearDiagnostics()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind === "aid:cache-lookup") {
    const imageUrls = Array.isArray(message.imageUrls)
      ? message.imageUrls.filter((imageUrl) => typeof imageUrl === "string")
      : [];
    cachedResultsFor(imageUrls)
      .then(({ hashes, results }) => sendResponse({ ok: true, hashes, results }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind !== "aid:analyze") return false;
  analyze(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "aid-check-image",
    title: "Analyze image locally",
    contexts: ["image"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "aid-check-image" && info.srcUrl && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      kind: "aid:check-image",
      srcUrl: info.srcUrl,
    }).catch(() => {});
  }
});
