import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/content/index.js", import.meta.url), "utf8");
const context = {
  window: { location: { hostname: "www.etsy.com", href: "https://www.etsy.com/listing/123" } },
  document: {
    readyState: "loading",
    addEventListener() {},
    querySelectorAll() { return []; },
  },
  chrome: { runtime: { onMessage: { addListener() {} } } },
  console,
};
vm.runInNewContext(`${source}
globalThis.__testApi = {
  collectPageData, getListingImages, getAnalyzableImages, isEtsyPage, isListingPage, scrapePostPage,
  scrapePostIdentity, scrapeProductInformation, scrapeReviewsAndImages, sendRuntimeMessage,
};`, context);
const {
  collectPageData, getListingImages, getAnalyzableImages, isEtsyPage, isListingPage, scrapePostPage,
  scrapePostIdentity, scrapeProductInformation, scrapeReviewsAndImages, sendRuntimeMessage,
} = context.__testApi;

function makeImage({ url, width = 500, height = 500, alt = "" }) {
  return {
    src: url,
    currentSrc: url,
    width,
    height,
    alt,
    getAttribute(name) {
      return name === "width" ? String(width) : name === "height" ? String(height) : null;
    },
  };
}

function makeDocument(images, selectors = new Map()) {
  return {
    querySelector: (selector) => selectors.get(selector) || null,
    querySelectorAll: (selector) => selector.includes("img") ? images : [],
  };
}

test("converts a synchronously invalidated runtime into a rejected message", async () => {
  context.chrome.runtime.sendMessage = () => {
    throw new Error("Extension context invalidated.");
  };
  await assert.rejects(
    sendRuntimeMessage({ kind: "aid:get-settings" }),
    /Extension context invalidated/,
  );
});

test("recognizes Etsy listing pages but rejects lookalike hosts", () => {
  assert.equal(isEtsyPage({ hostname: "www.etsy.com" }), true);
  assert.equal(isEtsyPage({ hostname: "etsy.com.evil.example" }), false);
  assert.equal(isListingPage({ hostname: "www.etsy.com", pathname: "/listing/123" }), true);
  assert.equal(isListingPage({ hostname: "www.etsy.com", pathname: "/listing/123/reviews" }), true);
  assert.equal(isListingPage({ hostname: "www.etsy.com", pathname: "/search?q=pattern" }), false);
  assert.equal(isListingPage({ hostname: "www.etsy.com", pathname: "/seller/listing/123" }), false);
});

test("deduplicates listing images and excludes small utility images", () => {
  const images = [
    makeImage({ url: "https://i.etsystatic.com/item.jpg" }),
    makeImage({ url: "https://i.etsystatic.com/item.jpg" }),
    makeImage({ url: "https://i.etsystatic.com/avatar.jpg" }),
    makeImage({ url: "https://i.etsystatic.com/icon.png", width: 32, height: 32 }),
    makeImage({ url: "https://bat.bing.com/action/0?event=pageLoad" }),
  ];
  const data = getListingImages({ querySelectorAll: () => images });
  const plainData = JSON.parse(JSON.stringify(data));
  assert.deepEqual(plainData, [{ url: "https://i.etsystatic.com/item.jpg", alt: "" }]);
});

test("uses Etsy listing selectors for seller and price", () => {
  const seller = { textContent: "SoftpawVintage" };
  const price = { textContent: "$25.00" };
  const selectors = new Map([
    ["[data-seller-cred-anchor]", seller],
    [".wt-text-title-larger", price],
  ]);
  const listing = collectPageData({
    querySelectorAll: () => [],
    querySelector: (selector) => selectors.get(selector) || null,
  }, { hostname: "etsy.com", href: "https://etsy.com/listing/123", pathname: "/listing/123" });
  assert.equal(listing.listing.seller, "SoftpawVintage");
  assert.equal(listing.listing.price, "$25.00");
});

test("uses the current listing URL before stale DOM listing identifiers", () => {
  const listing = collectPageData({
    querySelectorAll: () => [],
    querySelector: (selector) => selector === "[data-listing-id]"
      ? { getAttribute: () => "old-listing" } : null,
  }, {
    hostname: "etsy.com",
    href: "https://etsy.com/listing/4383107558/current",
    pathname: "/listing/4383107558/current",
  });
  assert.equal(listing.listing.listingId, "4383107558");
});

test("scopes listing images and separates customer review photos", () => {
  const listingImage = makeImage({ url: "https://i.etsystatic.com/listing.jpg" });
  const reviewImage = makeImage({ url: "https://i.etsystatic.com/iap/review.jpg" });
  const doc = {
    querySelectorAll: (selector) => {
      if (selector.includes(".listing-page-image-carousel-component")) return [listingImage];
      if (selector.includes("customer-photo-section")) return [reviewImage];
      return [];
    },
  };
  const scraped = scrapeReviewsAndImages(doc);
  assert.deepEqual(JSON.parse(JSON.stringify(scraped.images)), [
    { url: listingImage.src, alt: "" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(scraped.reviewImages)), [
    { url: reviewImage.src, alt: "" },
  ]);
});

test("scrapes every Etsy review card and its customer photo thumbnail", () => {
  const firstImage = makeImage({
    url: "https://i.etsystatic.com/iap/review-one.jpg",
    width: 60,
    height: 60,
    alt: "First finished garment",
  });
  const secondImage = makeImage({
    url: "https://i.etsystatic.com/iap/review-two.jpg",
    width: 60,
    height: 60,
    alt: "Second finished garment",
  });
  const makeReviewCard = (text, rating, image) => ({
    querySelector: (selector) => selector === ".wt-text-body [data-review-text-toggle-wrapper] p"
      ? { textContent: text }
      : selector === 'input[name="rating"]'
        ? { value: String(rating) }
        : null,
    querySelectorAll: (selector) => selector === "button.appreciation-photo img" && image
      ? [image]
      : [],
  });
  const doc = {
    querySelectorAll: (selector) => {
      if (selector === "[data-review-region]") {
        return [
          makeReviewCard("Step by step instructions were easy to follow.", 4, firstImage),
          makeReviewCard("Instructions were clear and the finished fit was great.", 5, secondImage),
        ];
      }
      if (selector.includes("listing-page-image-carousel-component")) return [];
      return [];
    },
  };

  const scraped = scrapeReviewsAndImages(doc);

  assert.deepEqual(JSON.parse(JSON.stringify(scraped.reviews)), [
    { text: "Step by step instructions were easy to follow.", rating: "4" },
    { text: "Instructions were clear and the finished fit was great.", rating: "5" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(scraped.reviewImages)), [
    { url: firstImage.src, alt: firstImage.alt },
    { url: secondImage.src, alt: secondImage.alt },
  ]);
});

test("does not treat recommendation cards as listing images", () => {
  const recommendationImage = makeImage({
    url: "https://i.etsystatic.com/recommendation.jpg",
  });
  const doc = {
    querySelectorAll: (selector) => selector.includes("listing-page-image-carousel-component")
      ? []
      : selector.includes("main-product-image") || selector.includes("secondary-product-image")
        ? []
        : [recommendationImage],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(getListingImages(doc))), []);
});

test("keeps recommendation images out of scraped data but includes them for analysis", () => {
  const listingImage = makeImage({ url: "https://i.etsystatic.com/listing.jpg" });
  const recommendationImage = makeImage({ url: "https://i.etsystatic.com/recommendation.jpg" });
  const doc = {
    querySelectorAll: (selector) => {
      if (selector.includes("listing-page-image-carousel-component")) return [listingImage];
      if (selector === "img") return [listingImage, recommendationImage];
      if (selector.includes("main-product-image") || selector.includes("secondary-product-image")) {
        return [];
      }
      return [];
    },
  };
  assert.equal(getListingImages(doc).length, 1);
  assert.equal(getAnalyzableImages(doc).length, 2);
});

test("collects listing metadata and image alternatives", () => {
  const title = { tagName: "H1", textContent: "Sewing pattern" };
  const seller = { textContent: "Pattern shop" };
  const images = [makeImage({ url: "https://i.etsystatic.com/item.jpg", alt: "Front view" })];
  const selectors = new Map([
    ["h1", title],
    ["[data-shop-name]", seller],
  ]);
  const listing = collectPageData({
    querySelectorAll: () => images,
    querySelector: (selector) => selectors.get(selector) || null,
  }, { hostname: "etsy.com", href: "https://etsy.com/listing/123" });
  assert.equal(listing.ok, true);
  assert.equal(listing.listing.title, "Sewing pattern");
  assert.equal(listing.listing.seller, "Pattern shop");
  assert.equal(listing.listing.images[0].alt, "Front view");
});

test("splits listing identity, product information, and review/image scraping", () => {
  const title = { tagName: "H1", textContent: "Pattern" };
  const seller = { textContent: "Maker" };
  const description = { textContent: "Printable instructions" };
  const review = {
    textContent: "Lovely pattern",
    getAttribute: (name) => name === "data-review-id" ? "r1" : null,
    querySelector: (selector) => selector.includes("review-text-toggle-wrapper")
      ? { textContent: "Lovely pattern" } : null,
    querySelectorAll: () => [],
  };
  const image = makeImage({ url: "https://i.etsystatic.com/pattern.jpg" });
  const selectors = new Map([
    ["h1", title],
    ["[data-shop-name]", seller],
    ['[data-testid="listing-page-description"]', description],
  ]);
  const doc = {
    querySelector: (selector) => selectors.get(selector) || null,
    querySelectorAll: (selector) => {
      if (selector.includes("listing-page-image-carousel-component") ||
          selector.includes("main-product-image")) return [image];
      if (selector === "[data-review-region]") return [review];
      if (selector.includes("description")) return [description];
      return [];
    },
  };
  const location = { hostname: "etsy.com", href: "https://etsy.com/listing/123", pathname: "/listing/123" };
  const scraped = scrapePostPage(doc, location);
  assert.equal(scraped.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(scraped.identity)), {
    listingId: "123", creator: "Maker", price: "", url: location.href, name: "Pattern",
  });
  assert.match(scraped.productInformation.description, /Printable instructions/);
  assert.equal(scraped.reviewsAndImages.images[0].url, image.src);
  assert.equal(scraped.reviewsAndImages.reviews[0].text, "Lovely pattern");
});
