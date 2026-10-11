# Privacy

RateThatSlop performs image analysis locally in the browser. Images discovered
by the Etsy content script are sent only to the extension's local service
worker and offscreen document for inference; they are not uploaded to a
RateThatSlop server.

The extension reads image URLs, and optionally the listing title, seller,
price, and page URL, only from Etsy pages where its content script runs. The
popup can request this data to display a current-page scan. It does not use an
analytics service.

On listing pages, three bounded scrapers can collect listing identity, product
details, reviews, ratings, and product image URLs for local processing.
Scraping is controlled by the `scrapingEnabled` extension-storage setting and
repeats are prevented by the Etsy listing ID. The local post record stores only
compact identity fields, SHA-256 image-byte hashes, timestamps, and an
optional structured AI rating. Raw description and review text is not stored
in that record.

The popup provides separate opt-in switches for scraping, uploading scores,
reading shared server information, AI description evaluation, user reviews,
and Etsy reviews. They default to enabled for compatibility, but disabled
features do not run. Reviews and description evaluation remain authenticated and unavailable to
signed-out users. Listing score reads and writes are available without a
signed-in extension session for the hackathon demo and contain only listing
metadata, scores, hashes, and optional image URLs.

Page-wide images that are not associated with a listing are synchronized, when
score uploads are enabled, only as a SHA-256 image hash, normalized AI score,
model version, optional source URL, and calculation timestamp. A later page
scan hashes the fetched bytes locally and can reuse that hash-only server
result; image bytes are never uploaded.

Completed local inference results are cached in Chrome extension storage as
compact result metadata keyed by a SHA-256 hash of the fetched image bytes.
The cache does not store downloaded image bytes or full pasted-image data
URLs. Page scans hash candidate images and check cached results before
starting new local inference.

Listing-level results and description assessments are reused from the local
cache for seven days when available. When signed in and the relevant feature
switches are enabled, the background listing workflow reads a fresh server
snapshot before evaluating or submitting anything. A description assessment
stores a normalized 0-1 score and a separate cleaned rationale; the original
description text is not stored in the extension cache or score snapshot.

The backend supports authenticated report submission and retrieval, stored
listing score snapshots, per-image analysis metadata, and description
evaluation. Automatic description evaluation is enabled by default and can be
disabled in the popup. When enabled, a signed-in user's listing description,
title, price, instructions, and attributes are sent to the RateThatSlop server
and processed by its configured language-model provider. Review text, image
URLs, and image bytes are not sent for this evaluation. Description evaluation
requires authentication; a user who is not signed in cannot access it but can
still use local image detection. Other listing-score behavior is unchanged:
fresh server results are used when available, with local inference for missing
or stale image results.

The extension sends only listing metadata, scores, and image hashes/optional
URLs for explicit score submission; it does not upload image bytes. Description
text is a separate authenticated feature governed by the popup preference.
Server-provided results are marked separately from fresh local inference.
Retention, account deletion behavior, report moderation, and any future remote
image-processing feature must be documented before release.

For the hackathon deployment, score snapshots and their compact image metadata
are publicly readable and writable through the score API. This is a deliberate
demo tradeoff and must be replaced with authenticated policies before a
production release.

Results are automated estimates of AI-image likelihood. They are not proof
that an image or seller is deceptive, fraudulent, or low quality. Etsy DOM
changes, inaccessible images, and model limitations can produce unavailable
or incorrect results.

The bundled model is based on the Sieve image detector project. Its version,
calibration, threshold, and provenance are recorded in
[`extension/model_manifest.json`](./extension/model_manifest.json).
