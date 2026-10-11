const form = document.querySelector("#analyze-form");
const urlInput = document.querySelector("#image-url");
const manualFeedback = document.querySelector("#status");
const manualResult = document.querySelector("#result");
const manualResultScore = document.querySelector("#result-score-value");
const manualResultLabel = document.querySelector("#result-label");
const manualResultSummary = document.querySelector("#result-summary");
const manualResultThreshold = document.querySelector("#result-threshold");
const manualResultModel = document.querySelector("#result-model");
const manualResultTime = document.querySelector("#result-time");
const analyzeButton = form.querySelector("button");
const settingInputs = [...document.querySelectorAll("[data-setting]")];
const DESCRIPTION_CACHE_PREFIX = "description-assessment:";
const REVIEWS_CACHE_PREFIX = "reviews-assessment:";

async function loadSettings() {
  const response = await chrome.runtime.sendMessage({ kind: "aid:get-settings" });
  if (!response?.ok) throw new Error(response?.error || "Could not load settings");
  for (const input of settingInputs) {
    input.checked = response.settings[input.dataset.setting] !== false;
  }
}

async function requireScrapingEnabled() {
  const response = await chrome.runtime.sendMessage({ kind: "aid:get-settings" });
  if (!response?.ok) throw new Error(response?.error || "Could not read feature settings");
  if (response.settings.scrapingEnabled === false) {
    throw new Error("Scraping is disabled in Feature settings.");
  }
}

async function saveSetting(input) {
  const response = await chrome.runtime.sendMessage({
    kind: "aid:set-settings",
    settings: { [input.dataset.setting]: input.checked },
  });
  if (!response?.ok) {
    input.checked = !input.checked;
    throw new Error(response?.error || "Could not save setting");
  }
}

loadSettings().catch((error) => {
  manualFeedback.textContent = `Settings unavailable: ${error.message}`;
});

async function getCurrentEtsyPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Could not find the active tab.");
  let page;
  try {
    page = await chrome.tabs.sendMessage(tab.id, { kind: "aid:collect-page" });
  } catch (error) {
    if (!/Could not establish connection|Receiving end does not exist/i.test(error?.message || "")) {
      throw error;
    }
    if (!chrome.scripting?.executeScript) {
      throw new Error("The Etsy page scanner is not connected. Reload the Etsy tab and try again.");
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content/index.js"],
    });
    page = await chrome.tabs.sendMessage(tab.id, { kind: "aid:collect-page" });
  }
  if (!page?.ok) throw new Error(page?.error || "Could not read this page.");
  return page.listing;
}

async function showResultOnPage(imageUrl, result) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:\/\/([^.]+\.)?etsy\.com\//i.test(tab.url || "")) return;
  await chrome.tabs.sendMessage(tab.id, {
    kind: "aid:show-result",
    imageUrl,
    result,
  });
}

let scanInProgress = false;

function descriptionFingerprint(description) {
  return `${description.length}:${description.slice(0, 32)}:${description.slice(-32)}`;
}

function descriptionRationale(result) {
  return typeof result?.descriptionRationale === "string"
    ? result.descriptionRationale
    : typeof result?.overall_rationale === "string"
      ? result.overall_rationale
        .replace(/^\s*AI-writing likelihood:\s*\d+\s*\/\s*100(?:\s*\([^)]*\))?\.\s*/i, "")
        .trim()
      : "";
}

function descriptionAssessmentState(listing, storedScore = null) {
  const description = typeof listing.description === "string" ? listing.description.trim() : "";
  if (!description) return { status: "unavailable", message: "No listing description was available to review." };
  if (Number.isFinite(Number(storedScore?.descriptionScore))) {
    return {
      status: "available",
      result: {
        ai_likeness_score: Math.round(Number(storedScore.descriptionScore) * 100),
        overall_rationale: storedScore.descriptionRationale || "",
      },
    };
  }
  return { status: "pending", message: "Description submitted. Waiting for AI review…" };
}

function isAuthenticationRequiredError(error) {
  return /sign-in is required for server features/i.test(error?.message || "");
}

function reviewsFingerprint(reviewsAndImages) {
  return JSON.stringify(reviewsAndImages);
}

function reviewsAssessmentState(reviewsAndImages) {
  const reviewCount = Array.isArray(reviewsAndImages?.reviews) ? reviewsAndImages.reviews.length : 0;
  const photoCount = Array.isArray(reviewsAndImages?.reviewImages) ? reviewsAndImages.reviewImages.length : 0;
  const ratings = typeof reviewsAndImages?.ratings === "string" ? reviewsAndImages.ratings.trim() : "";
  if (!reviewCount && !photoCount && !ratings) {
    return { status: "unavailable", message: "No review information was available to assess." };
  }
  return { status: "pending", message: "Reviews submitted. Waiting for AI review…" };
}

async function requestReviewsAssessment(listing) {
  const reviewsAndImages = listing.reviewsAndImages;
  const initial = reviewsAssessmentState(reviewsAndImages);
  if (initial.status !== "pending") {
    document.dispatchEvent(new CustomEvent("rts:reviews-assessment", { detail: initial }));
    return initial;
  }
  const cacheKey = `${REVIEWS_CACHE_PREFIX}${listing.listingId || "unknown"}`;
  const fingerprint = reviewsFingerprint(reviewsAndImages);
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey]?.fingerprint === fingerprint) {
    const assessment = { status: "available", result: cached[cacheKey].result };
    document.dispatchEvent(new CustomEvent("rts:reviews-assessment", { detail: assessment }));
    return assessment;
  }
  document.dispatchEvent(new CustomEvent("rts:reviews-assessment", { detail: initial }));
  try {
    const response = await chrome.runtime.sendMessage({
      kind: "aid:evaluate-reviews",
      reviewsAndImages,
    });
    if (!response?.ok) throw new Error(response?.error || "Reviews assessment failed");
    const score = Number(response.result?.review_text_ai_assessment?.ai_likeness_score);
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      throw new Error("AI returned an invalid reviews assessment");
    }
    const assessment = { status: "available", result: response.result };
    await chrome.storage.local.set({
      [cacheKey]: { fingerprint, result: response.result, cachedAt: new Date().toISOString() },
    });
    document.dispatchEvent(new CustomEvent("rts:reviews-assessment", { detail: assessment }));
    return assessment;
  } catch (error) {
    const message = isAuthenticationRequiredError(error)
      ? "Not available until login."
      : error.message || "Reviews assessment failed";
    const assessment = isAuthenticationRequiredError(error)
      ? { status: "unavailable", message }
      : { status: "error", message };
    document.dispatchEvent(new CustomEvent("rts:reviews-assessment", { detail: assessment }));
    if (assessment.status === "error") console.error("Reviews assessment failed:", error);
    return assessment;
  }
}

async function requestDescriptionAssessment(listing, storedScore = null) {
  const description = typeof listing.description === "string" ? listing.description.trim() : "";
  if (!description) return;
  if (Number.isFinite(Number(storedScore?.descriptionScore))) {
    const assessment = descriptionAssessmentState(listing, storedScore);
    document.dispatchEvent(new CustomEvent("rts:description-assessment", { detail: assessment }));
    return assessment;
  }
  const cacheKey = `${DESCRIPTION_CACHE_PREFIX}${listing.listingId || "unknown"}`;
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey]?.fingerprint === descriptionFingerprint(description)) {
    const assessment = { status: "available", result: cached[cacheKey].result };
    document.dispatchEvent(new CustomEvent("rts:description-assessment", { detail: assessment }));
    return assessment;
  }
  document.dispatchEvent(new CustomEvent("rts:description-assessment", {
    detail: descriptionAssessmentState(listing),
  }));
  try {
    const response = await chrome.runtime.sendMessage({
      kind: "aid:evaluate-description",
      description,
      listingDetails: {
        title: listing.title || "",
        price: listing.price || "",
        instructions: listing.instructions || "",
        attributes: listing.attributes || "",
      },
    });
    if (!response?.ok) throw new Error(response?.error || "Description review failed");
    const score = Number(response.result?.ai_likeness_score);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new Error("AI returned an invalid description assessment");
    }
    const assessment = { status: "available", result: response.result };
    await chrome.storage.local.set({
      [cacheKey]: {
        fingerprint: descriptionFingerprint(description),
        result: response.result,
        cachedAt: new Date().toISOString(),
      },
    });
    document.dispatchEvent(new CustomEvent("rts:description-assessment", { detail: assessment }));
    return assessment;
  } catch (error) {
    if (isAuthenticationRequiredError(error)) {
      document.dispatchEvent(new CustomEvent("rts:description-assessment", {
        detail: { status: "unavailable", message: "Not available until login." },
      }));
      return { status: "unavailable", message: "Not available until login." };
    }
    document.dispatchEvent(new CustomEvent("rts:description-assessment", {
      detail: { status: "error", message: error.message || "Description review failed" },
    }));
    console.error("Description assessment failed:", error);
    return { status: "error", message: error.message || "Description review failed" };
  }
}

async function scanCurrentPage({ forceRefresh = false } = {}) {
  // Avoid running two expensive listing scans at the same time.
  if (scanInProgress) return;
  scanInProgress = true;

  try {
    await requireScrapingEnabled();
    const listing = await getCurrentEtsyPage();
    const evidenceImages = Array.isArray(listing.images) ? listing.images : [];
    const images = Array.isArray(listing.analyzableImages) && listing.analyzableImages.length
      ? listing.analyzableImages.slice(0, 100)
      : evidenceImages.slice(0, 100);
    const evidenceUrls = new Set(evidenceImages.map((image) => image.url));
    const storedScore = !forceRefresh && listing.listingId
      ? await chrome.runtime.sendMessage({
        kind: "aid:get-listing-score",
        listingId: listing.listingId,
      })
      : null;
    const listingScore = storedScore?.ok && storedScore.available && storedScore.score?.overall !== null
      ? storedScore.score
      : null;
    if (!images.length) {
      throw new Error("No listing images found. Wait for the Etsy listing photos to load, then click Scan current listing again.");
    }

    // Show thumbnails right away rather than waiting for the model to finish.
    const scoreItems = images.map((image) => ({
      url: image.url,
      alt: image.alt || "Etsy listing image",
      result: null,
      status: "Analyzing…",
      listingEvidence: evidenceUrls.has(image.url),
    }));
    document.dispatchEvent(new CustomEvent("rts:analysis-start", {
      detail: {
        title: listing.title || "Current Etsy listing",
        images: scoreItems,
        listingScore,
        descriptionAssessment: descriptionAssessmentState(listing),
        reviewsAssessment: reviewsAssessmentState(listing.reviewsAndImages),
      }
    }));
    const descriptionPromise = requestDescriptionAssessment(listing, listingScore);
    const reviewsPromise = requestReviewsAssessment(listing);

    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      try {
        // Do NOT convert to a huge data URL in the popup. The original extension
        // sends the image URL to its offscreen ONNX analysis pipeline.
        const response = await chrome.runtime.sendMessage({
          kind: "aid:analyze",
          imageUrl: image.url,
          force: true,
          meta: listing,
        });
        if (!response?.ok) throw new Error(response?.error || "Analysis failed");
        scoreItems[i] = { ...scoreItems[i], result: response.result, status: "complete" };
        // Same badge mechanism used by the original scanner on Etsy pages.
        try {
          if (response?.ok) await showResultOnPage(image.url, response.result);
        } catch (error) {
          console.warn("Could not add on-page badge:", error);
        }
      } catch (error) {
        scoreItems[i] = { ...scoreItems[i], status: error.message || "Analysis failed" };
        console.error("Image analysis failed:", image.url, error);
      }

      document.dispatchEvent(new CustomEvent("rts:analysis-progress", {
        detail: { index: i, item: scoreItems[i], complete: i + 1, total: images.length }
      }));
    }
    const descriptionAssessment = await descriptionPromise;
    const reviewsAssessment = await reviewsPromise;
    const descriptionPercent = Number(descriptionAssessment?.result?.ai_likeness_score);
    const imageScores = scoreItems
      .filter((item) => evidenceUrls.has(item.url))
      .map((item) => item.result)
      .filter((result) => Number.isFinite(Number(result?.score)))
      .map((result) => Number(result.score))
      .sort((a, b) => a - b);
    if ((forceRefresh || !listingScore) && imageScores.length) {
      const mean = imageScores.reduce((sum, score) => sum + score, 0) / imageScores.length;
      const position = (imageScores.length - 1) * 0.9;
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      const highRisk = imageScores[lower] + (imageScores[upper] - imageScores[lower]) * (position - lower);
      const imageScore = mean * 0.6 + highRisk * 0.4;
      const descriptionScore = Number.isFinite(descriptionPercent) ? descriptionPercent / 100 : null;
      const aggregateScore = descriptionScore === null
        ? imageScore
        : (imageScore * 0.6 + descriptionScore * 0.15) / 0.75;
      await chrome.runtime.sendMessage({
        kind: "aid:submit-score",
        payload: {
          platform: "etsy",
          listingId: listing.listingId,
          listingUrl: listing.pageUrl,
          title: listing.title,
          score: {
            totalImageScore: imageScore,
            descriptionScore,
            aggregateScore,
            modelVersion: scoreItems.find((item) => item.result)?.result?.modelVersion || "local",
            scoringVersion: "1",
            descriptionRationale: descriptionRationale(descriptionAssessment?.result),
          },
          images: scoreItems.filter((item) => evidenceUrls.has(item.url) && item.result).map((item) => ({
            imageHash: item.result.imageId,
            imageUrl: item.url,
            aiScore: item.result.score,
            modelVersion: item.result.modelVersion,
          })),
        },
      }).then((response) => {
        if (response?.ok === false) {
          throw new Error(response.error || "Score upload failed");
        }
      }).catch((error) => {
        console.error("Score upload failed:", error);
        document.dispatchEvent(new CustomEvent("rts:server-upload-failed", {
          detail: { message: error.message },
        }));
      });
    }
    document.dispatchEvent(new CustomEvent("rts:analysis", {
      detail: { type: "listing", title: listing.title || "Current Etsy listing", images: scoreItems, listingScore,
        descriptionAssessment, reviewsAssessment }
    }));
  } catch (error) {
    document.dispatchEvent(new CustomEvent("rts:scan-unavailable", {
      detail: { message: error.message }
    }));
    console.error("Listing scan failed:", error);
    return false;
  } finally {
    scanInProgress = false;
  }
  return true;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  manualResult.hidden = true;
  manualFeedback.textContent = "Analyzing locally...";
  analyzeButton.disabled = true;
  try {
    const imageUrl = urlInput.value.trim();
    const response = await chrome.runtime.sendMessage({
      kind: "aid:analyze",
      imageUrl,
    });
    if (!response?.ok) throw new Error(response?.error || "Inference failed");
    const { result } = response;
    const isAi = result.label === "likely-ai";
    manualResultScore.textContent = `${(result.score * 100).toFixed(1)}%`;
    manualResultLabel.textContent = isAi ? "Likely AI-generated" : "Likely human-made";
    manualResultSummary.textContent = isAi
      ? "This is an automated estimate based on visual patterns."
      : "This image shows a low AI signal based on the visual analysis.";
    manualResultThreshold.textContent = `${(result.threshold * 100).toFixed(1)}%`;
    manualResultModel.textContent = result.modelVersion;
    manualResultTime.textContent = `${result.processingTimeMs} ms`;
    manualResult.hidden = false;
    manualFeedback.textContent = "Analysis complete.";
  } catch (error) {
    manualFeedback.textContent = `Error: ${error.message}`;
  } finally {
    analyzeButton.disabled = false;
  }
});

export { getCurrentEtsyPage, scanCurrentPage };

document.querySelector("#scan-page").addEventListener("click", async () => {
  const scanButton = document.querySelector("#scan-page");
  scanButton.disabled = true;
  manualFeedback.textContent = "Scanning all eligible images on this page…";
  try {
    if (await scanCurrentPage({ forceRefresh: true })) {
      manualFeedback.textContent = "Listing scan complete.";
    }
  } catch (error) {
    manualFeedback.textContent = `Error: ${error.message}`;
  } finally {
    scanButton.disabled = false;
  }
});

// On popup launch, scan an Etsy listing without requiring authentication.
// For other pages, the Scores tab displays guidance instead of running a scan.
async function autoScanEtsyListing() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!/^https?:\/\/(?:[^/]+\.)?etsy\.com\/listing\/\d+(?:[/?#]|$)/i.test(tab?.url || "")) {
      document.dispatchEvent(new CustomEvent("rts:scan-unavailable", {
        detail: { message: "Open an Etsy listing to see its image ratings automatically. You can still analyze a pasted image URL in Manual." }
      }));
      return;
    }
    await scanCurrentPage();
  } catch (error) {
    document.dispatchEvent(new CustomEvent("rts:scan-unavailable", { detail: { message: error.message } }));
  }
}

// Run after the other popup modules have attached their listeners.
document.addEventListener("rts:scan-requested", autoScanEtsyListing);
