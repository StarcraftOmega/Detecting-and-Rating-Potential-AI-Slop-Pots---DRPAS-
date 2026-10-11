const form = document.querySelector("#analyze-form");
const urlInput = document.querySelector("#image-url");
const manualFeedback = document.querySelector("#manual-feedback");
const manualResult = document.querySelector("#manual-result");
const manualResultLabel = document.querySelector("#manual-result-label");
const manualResultSummary = document.querySelector("#manual-result-summary");
const manualResultMeta = document.querySelector("#manual-result-meta");
const analyzeButton = form.querySelector("button");
const settingInputs = [...document.querySelectorAll("[data-setting]")];

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
  const page = await chrome.tabs.sendMessage(tab.id, { kind: "aid:collect-page" });
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

function descriptionAssessmentState(listing) {
  const description = typeof listing.description === "string" ? listing.description.trim() : "";
  if (!description) return { status: "unavailable", message: "No listing description was available to review." };
  return { status: "pending", message: "Description submitted. Waiting for AI review…" };
}

function isAuthenticationRequiredError(error) {
  return /sign-in is required for server features/i.test(error?.message || "");
}

async function requestDescriptionAssessment(listing) {
  const description = typeof listing.description === "string" ? listing.description.trim() : "";
  if (!description) return;
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
    document.dispatchEvent(new CustomEvent("rts:description-assessment", {
      detail: { status: "available", result: response.result },
    }));
  } catch (error) {
    if (isAuthenticationRequiredError(error)) {
      document.dispatchEvent(new CustomEvent("rts:description-assessment", {
        detail: { status: "unavailable", message: "Not available until login." },
      }));
      return;
    }
    document.dispatchEvent(new CustomEvent("rts:description-assessment", {
      detail: { status: "error", message: error.message || "Description review failed" },
    }));
    console.error("Description assessment failed:", error);
  }
}

async function scanCurrentPage() {
  // Avoid running two expensive listing scans at the same time.
  if (scanInProgress) return;
  scanInProgress = true;

  try {
    await requireScrapingEnabled();
    const listing = await getCurrentEtsyPage();
    const images = Array.isArray(listing.images) ? listing.images.slice(0, 20) : [];
    const storedScore = listing.listingId
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
    }));
    document.dispatchEvent(new CustomEvent("rts:analysis-start", {
      detail: {
        title: listing.title || "Current Etsy listing",
        images: scoreItems,
        listingScore,
        descriptionAssessment: descriptionAssessmentState(listing),
      }
    }));
    void requestDescriptionAssessment(listing);

    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      try {
        // Do NOT convert to a huge data URL in the popup. The original extension
        // sends the image URL to its offscreen ONNX analysis pipeline.
        const response = await chrome.runtime.sendMessage({
          kind: "aid:analyze",
          imageUrl: image.url,
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
    document.dispatchEvent(new CustomEvent("rts:analysis", {
      detail: { type: "listing", title: listing.title || "Current Etsy listing", images: scoreItems, listingScore }
    }));
  } catch (error) {
    document.dispatchEvent(new CustomEvent("rts:scan-unavailable", {
      detail: { message: error.message }
    }));
    console.error("Listing scan failed:", error);
  } finally {
    scanInProgress = false;
  }
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
    manualResultLabel.textContent = isAi ? "Likely AI-generated" : "Likely human-made";
    manualResultSummary.textContent = isAi
      ? "This is an automated estimate based on visual patterns."
      : "This image shows a low AI signal based on the visual analysis.";
    manualResultMeta.textContent =
      `Score ${(result.score * 100).toFixed(1)}% · Threshold ${(result.threshold * 100).toFixed(1)}% · ` +
      `Model ${result.modelVersion} · ${result.processingTimeMs} ms`;
    manualResult.hidden = false;
    manualFeedback.textContent = "Analysis complete.";
  } catch (error) {
    manualFeedback.textContent = `Error: ${error.message}`;
  } finally {
    analyzeButton.disabled = false;
  }
});

export { getCurrentEtsyPage, scanCurrentPage };

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
