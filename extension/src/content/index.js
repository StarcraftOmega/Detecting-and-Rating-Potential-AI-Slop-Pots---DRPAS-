const MAX_IMAGES = 100;
const ETSY_HOST_RE = /(^|\.)etsy\.com$/i;
const IGNORED_IMAGE_RE = /(avatar|icon|logo|sprite|badge|favicon|profile|shop[_-]?owner)/i;
const ETSY_IMAGE_HOST_RE = /(^|\.)etsystatic\.com$/i;
const analyzedResults = new Map();
const inFlightImages = new Set();
const evaluatedReviewListings = new Set();
let pageScanPromise = null;
const RESCAN_INTERVAL_MS = 5000;

function sendRuntimeMessage(message) {
  try {
    return Promise.resolve(chrome.runtime.sendMessage(message));
  } catch (error) {
    return Promise.reject(error);
  }
}

function isEtsyPage(location = window.location) {
  return ETSY_HOST_RE.test(location.hostname);
}

function isListingPage(location = window.location) {
  return isEtsyPage(location) &&
    /^\/listing\/\d+(?:\/|$)/i.test(String(location.pathname || ""));
}

function getImageUrl(img) {
  return img.currentSrc || img.src || img.getAttribute("data-src") || "";
}

function getImageListingId(img) {
  const link = img.closest?.('a[href*="/listing/"]');
  const match = String(link?.href || "").match(/\/listing\/(\d+)(?:[/?#]|$)/i);
  return match?.[1] || "";
}

function isListingImage(img) {
  const url = getImageUrl(img);
  const hostname = url.match(/^https?:\/\/([^/?#]+)/i)?.[1] || "";
  if (!ETSY_IMAGE_HOST_RE.test(hostname) || IGNORED_IMAGE_RE.test(url)) return false;

  const width = Number(img.naturalWidth || img.width || img.getAttribute("width") || 0);
  const height = Number(img.naturalHeight || img.height || img.getAttribute("height") || 0);
  return (!width && !height) || (width >= 160 && height >= 160);
}

function getListingImages(doc = document) {
  const scopedImages = doc.querySelectorAll(
    ".listing-page-image-carousel-component [data-palette-listing-image] img, " +
    ".listing-page-image-carousel-component [data-listing-image] img",
  );
  if (scopedImages.length) return collectImages(scopedImages);

  const productImages = doc.querySelectorAll(
    'img[data-perf-group="main-product-image"], ' +
    'img[data-perf-group="secondary-product-image"]',
  );
  return collectImages(productImages);
}

function getAnalyzableImages(doc = document) {
  return collectImages(doc.querySelectorAll("img"));
}

function collectImages(imageElements) {
  const seen = new Set();
  const images = [];
  for (const img of imageElements) {
    if (!isListingImage(img)) continue;
    const url = getImageUrl(img);
    if (seen.has(url)) continue;
    seen.add(url);
    const listingId = getImageListingId(img);
    images.push({
      url,
      alt: img.alt?.trim() || "",
      ...(listingId ? { listingId } : {}),
    });
    if (images.length >= MAX_IMAGES) break;
  }
  return images;
}

function collectReviewImages(imageElements) {
  const seen = new Set();
  const images = [];
  for (const img of imageElements) {
    const url = getImageUrl(img);
    const hostname = url.match(/^https?:\/\/([^/?#]+)/i)?.[1] || "";
    if (!ETSY_IMAGE_HOST_RE.test(hostname) || IGNORED_IMAGE_RE.test(url) || seen.has(url)) {
      continue;
    }
    seen.add(url);
    images.push({ url, alt: img.alt?.trim() || "" });
    if (images.length >= MAX_IMAGES) break;
  }
  return images;
}

function getText(doc, selectors) {
  for (const selector of selectors) {
    const element = doc.querySelector(selector);
    if (!element) continue;
    const value = element.tagName === "META"
      ? element.getAttribute("content")
      : element.textContent;
    if (value?.trim()) return value.trim();
  }

  return "";
}

function getListingId(doc = document, location = window.location) {
  if (!isListingPage(location)) return "";
  const pathMatch = String(location.pathname || "").match(/^\/listing\/(\d+)(?:\/|$)/i);
  return pathMatch?.[1] ||
    doc.querySelector("[data-listing-id]")?.getAttribute("data-listing-id") ||
    doc.querySelector("[data-product-id]")?.getAttribute("data-product-id") || "";
}

function collectPageData(doc = document, location = window.location, options = {}) {
  if (!isEtsyPage(location)) return { ok: false, error: "This is not an Etsy page." };
  return {
    ok: true,
    listing: {
      images: getListingImages(doc),
      analyzableImages: getAnalyzableImages(doc),
      title: getText(doc, ["h1", "[data-listing-title]", "[data-title]", 'meta[property="og:title"]']),
      seller: getText(doc, [
        "[data-seller-cred-anchor]",
        "[data-shop-name]",
        "[data-seller-name]",
        ".shop-name",
        ".shop-name-text",
      ]),
      price: getText(doc, [
        '[data-price]',
        ".wt-text-title-larger .currency-value",
        ".wt-text-title-larger",
        ".currency-value",
        ".price",
      ]).replace(/^price:\s*/i, ""),
      listingId: getListingId(doc, location),
      pageUrl: location.href,
      ...scrapeProductInformation(doc),
      reviewsAndImages: scrapeReviewsAndImages(doc, options.includeEtsyReviews !== false),
    },
  };
}

function getAllText(doc, selectors, limit = 12000) {
  const values = [];
  const seen = new Set();
  for (const selector of selectors) {
    for (const element of doc.querySelectorAll(selector)) {
      const value = element.textContent?.replace(/\s+/g, " ").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      values.push(value);
      const combined = values.join("\n");
      if (combined.length >= limit) return combined.slice(0, limit);
    }
  }
  return values.join("\n");
}

function scrapePostIdentity(doc = document, location = window.location) {
  const page = collectPageData(doc, location);
  if (!page.ok) return page;
  return {
    listingId: page.listing.listingId,
    creator: page.listing.seller,
    price: page.listing.price,
    url: page.listing.pageUrl,
    name: page.listing.title,
  };
}

function scrapeProductInformation(doc = document) {
  return {
    description: getAllText(doc, [
      "[data-product-details-description-text-content]",
      '[data-testid="listing-page-description"]',
      '[data-listing-description]',
      '[data-testid="description"]',
      'meta[name="description"]',
      'meta[property="og:description"]',
    ]),
    instructions: getAllText(doc, [
      '[data-product-details-description-text-content]',
      '[data-testid*="instruction"]',
      '[data-testid*="details"]',
    ]),
    attributes: getAllText(doc, [
      '[data-testid="listing-attribute"]',
      '[data-attribute]',
      "table",
    ]),
  };
}

function scrapeReviewsAndImages(doc = document, includeEtsyReviews = true) {
  if (!includeEtsyReviews) {
    return { ratings: "", reviews: [], images: getListingImages(doc), reviewImages: [] };
  }
  const reviews = [];
  const reviewCards = doc.querySelectorAll("[data-review-region]");
  const reviewImages = [];
  if (reviewCards.length) {
    for (const card of reviewCards) {
      const textElement = card.querySelector?.(
        ".wt-text-body [data-review-text-toggle-wrapper] p",
      );
      const text = textElement?.textContent?.replace(/\s+/g, " ").trim();
      const ratingInput = card.querySelector?.('input[name="rating"]');
      const ratingText = ratingInput?.value || ratingInput?.getAttribute?.("value") ||
        card.getAttribute?.("data-rating") || "";
      if (text && text.length >= 2) {
        reviews.push({ text: text.slice(0, 2000), rating: ratingText });
      }
      reviewImages.push(...(card.querySelectorAll?.("button.appreciation-photo img") || []));
      if (reviews.length >= 100) break;
    }
  } else {
    const reviewElements = doc.querySelectorAll(
      '[data-review-id], [data-review-text], [data-testid="review"]',
    );
    for (const element of reviewElements) {
      const text = element.textContent?.replace(/\s+/g, " ").trim();
      if (!text || text.length < 2) continue;
      const ratingText = element.getAttribute("data-rating") ||
        element.querySelector?.('[aria-label*="star" i]')?.getAttribute("aria-label") || "";
      reviews.push({ text: text.slice(0, 2000), rating: ratingText });
      if (reviews.length >= 100) break;
    }
    reviewImages.push(...doc.querySelectorAll(
      '[data-location="customer-photo-section"] img',
    ));
  }
  const uniqueReviews = reviews.filter((review, index) =>
    reviews.findIndex((candidate) =>
      candidate.text === review.text && candidate.rating === review.rating,
    ) === index,
  );
  const collectedReviewImages = collectReviewImages(reviewImages);
  return {
    ratings: getAllText(doc, [".reviews-header-ratings"], 2000),
    reviews: uniqueReviews,
    images: getListingImages(doc),
    reviewImages: collectedReviewImages,
  };
}

function scrapePostPage(doc = document, location = window.location, options = {}) {
  if (!isListingPage(location)) return { ok: false, error: "This is not an Etsy listing page." };
  return {
    ok: true,
    identity: scrapePostIdentity(doc, location),
    productInformation: scrapeProductInformation(doc),
    reviewsAndImages: scrapeReviewsAndImages(doc, options.includeEtsyReviews !== false),
  };
}

function requestReviewEvaluation(listingId, reviewsAndImages) {
  if (!listingId || evaluatedReviewListings.has(listingId) ||
      (!reviewsAndImages?.reviews?.length && !reviewsAndImages?.reviewImages?.length)) {
    return;
  }
  evaluatedReviewListings.add(listingId);
  sendRuntimeMessage({
    kind: "aid:evaluate-reviews",
    listingId,
    reviewsAndImages,
  }).then((response) => {
    if (!response?.ok) {
      console.warn("RateThatSlop could not evaluate Etsy reviews:", response?.error);
      return;
    }
  }).catch((error) => {
    console.warn("RateThatSlop could not evaluate Etsy reviews:", error);
  });
}

function setImageBadge(img, result) {
  const host = img.parentElement;
  if (!host) return;
  host.querySelector(".ratethatslop-image-badge")?.remove();
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const hostRect = host.getBoundingClientRect();
  const imageRect = img.getBoundingClientRect();
  const left = Math.max(8, imageRect.left - hostRect.left + 8);
  const bottom = Math.max(8, hostRect.bottom - imageRect.bottom + 8);
  const badge = document.createElement("span");
  badge.className = "ratethatslop-image-badge";
  badge.textContent = result?.label === "likely-ai" ? "Likely AI" : "Likely Real";
  badge.style.cssText = [
    "position:absolute", `bottom:${bottom}px`, `left:${left}px`, "z-index:2", "padding:4px 7px",
    "border-radius:999px", "font:600 11px system-ui,sans-serif", "color:#fff",
    `background:${result?.label === "likely-ai" ? "#b42318" : "#287d3c"}`,
  ].join(";");
  host.appendChild(badge);
}

function setImageBadges(imageUrl, result) {
  for (const image of document.querySelectorAll("img")) {
    if (getImageUrl(image) === imageUrl) setImageBadge(image, result);
  }
}

async function analyzePageImages(data) {
  if (pageScanPromise) return pageScanPromise;
  pageScanPromise = (async () => {
    const listingEvidenceImages = Array.isArray(data.listingEvidenceImages)
      ? data.listingEvidenceImages
      : data.listing.images;
    const imagesToAnalyze = [];
    const localCached = new Set();
    let cacheResponse;
    try {
      cacheResponse = await sendRuntimeMessage({
        kind: "aid:cache-lookup",
        imageUrls: data.listing.images.map((image) => image.url),
      });
    } catch (error) {
      console.warn("RateThatSlop could not read cached image results:", error);
    }
    if (cacheResponse?.ok && cacheResponse.results) {
      for (const image of data.listing.images) {
        const cached = cacheResponse.results[image.url];
        if (!cached) continue;
        analyzedResults.set(image.url, cached.result);
        localCached.add(image.url);
        setImageBadges(image.url, cached.result);
      }
    }

    for (const image of data.listing.images) {
      if (localCached.has(image.url) && !image.listingId) continue;
      if (analyzedResults.has(image.url)) {
        if (image.listingId) {
          imagesToAnalyze.push(image);
          continue;
        }
        setImageBadges(image.url, analyzedResults.get(image.url));
        continue;
      }
      imagesToAnalyze.push(image);
    }

    for (const image of imagesToAnalyze) {
      if (inFlightImages.has(image.url)) continue;
      inFlightImages.add(image.url);
      try {
        const imageHash = cacheResponse?.hashes?.[image.url];
        const response = await sendRuntimeMessage({
          kind: "aid:analyze",
          imageUrl: image.url,
          imageHash,
          meta: { ...data.listing, listingId: image.listingId || data.listing.listingId },
        });
        if (response?.ok) {
          analyzedResults.set(image.url, response.result);
          setImageBadges(image.url, response.result);
        }
      } catch (error) {
        console.warn("RateThatSlop could not analyze Etsy image:", error);
      } finally {
        inFlightImages.delete(image.url);
      }
    }
    if (isListingPage() && data.listing.listingId) {
      sendRuntimeMessage({
        kind: "aid:sync-listing",
        listing: data.listing,
        images: [...analyzedResults.entries()]
          .filter(([url]) => listingEvidenceImages.some((image) => image.url === url))
          .map(([url, result]) => ({ url, imageId: result.imageId, aiScore: result.score, modelVersion: result.modelVersion })),
      }).then((response) => {
        if (response?.ok === false) {
          console.warn("RateThatSlop could not sync listing:", response.error);
        }
      }).catch((error) => {
        console.warn("RateThatSlop could not sync listing:", error);
      });
    }
  })().finally(() => {
    pageScanPromise = null;
  });
  return pageScanPromise;
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.kind === "aid:collect-page") {
      sendRuntimeMessage({ kind: "aid:get-settings" }).then((settingsResponse) => {
        sendResponse(collectPageData(document, window.location, {
          includeEtsyReviews: settingsResponse?.settings?.etsyReviewsEnabled !== false,
        }));
      }).catch(() => sendResponse(collectPageData()));
      return true;
    }
    if (message?.kind === "aid:show-result" &&
        typeof message.imageUrl === "string" &&
        message.result) {
      setImageBadges(message.imageUrl, message.result);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.kind === "aid:scrape-post") {
      sendRuntimeMessage({ kind: "aid:get-settings" }).then((settingsResponse) => {
        sendResponse(scrapePostPage(document, window.location, {
          includeEtsyReviews: settingsResponse?.settings?.etsyReviewsEnabled !== false,
        }));
      }).catch(() => sendResponse(scrapePostPage()));
      return true;
    }
    return false;
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const scan = () => {
    sendRuntimeMessage({ kind: "aid:get-settings" }).then((settingsResponse) => {
      if (settingsResponse?.settings?.scrapingEnabled === false) return;
      const data = collectPageData();
    if (data.ok && data.listing.analyzableImages.length) {
      analyzePageImages({
        ...data,
        listingEvidenceImages: data.listing.images,
        listing: {
          ...data.listing,
          images: data.listing.analyzableImages,
        },
      });
    }
    if (isListingPage() && getListingId(document, window.location)) {
      const post = scrapePostPage(document, window.location, {
        includeEtsyReviews: settingsResponse?.settings?.etsyReviewsEnabled !== false,
      });
      sendRuntimeMessage({
        kind: "aid:scrape-post",
        post,
      })
        .catch(() => {});
      if (settingsResponse?.settings?.etsyReviewsEnabled !== false) {
        requestReviewEvaluation(post.identity.listingId, post.reviewsAndImages);
      }
      }
    }).catch(() => {});
  };
  let scanTimer = 0;
  const scheduleScan = () => {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 250);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleScan, { once: true });
  } else {
    scheduleScan();
  }

  if (typeof window.setTimeout === "function") {
    for (const delay of [1500, 4000, 8000]) {
      window.setTimeout(scan, delay);
    }
    if (typeof window.setInterval === "function") {
      window.setInterval(scan, RESCAN_INTERVAL_MS);
    }

    if (typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver((mutations) => {
        const relevant = mutations.some((mutation) => {
          if (mutation.type === "childList") {
            return [...mutation.addedNodes].some((node) =>
              node.nodeType === Node.ELEMENT_NODE &&
              (node.matches?.("img") || node.querySelector?.("img")));
          }
          return mutation.type === "attributes" &&
            (mutation.target.matches?.("img") &&
              ["src", "srcset", "data-src", "data-srcset"].includes(mutation.attributeName));
        });
        if (relevant) scheduleScan();
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "data-src", "data-srcset"],
      });
    }
  }
}
