# RateThatSlop Project Guidelines

## Project Scope

RateThatSlop is a Chrome Manifest V3 extension for detecting potentially
AI-generated sewing-pattern images on Etsy and presenting a separate,
explainable listing-risk rating. Keep the extension local-first: image inference runs in the browser and image
bytes must never be uploaded by ordinary server lookups, score reads, score
submissions, reports, or description evaluation. Server synchronization is
authenticated and opt-in at the feature level, except for the temporary
hackathon score path documented below. Image inference remains local by
default.

## Architecture

- `extension/src/background/index.js` owns message routing, model-manifest
  loading, inference requests, caching, and error propagation.
- Prefer an offscreen document for ONNX Runtime image decoding and inference:
  `extension/src/background/offscreen.html` and
  `extension/src/background/offscreen.js`.
- `extension/src/content/index.js` owns Etsy DOM discovery, listing metadata
  extraction, throttled image requests, and page badges. Keep model logic out
  of the content script.
- Treat `extension/src/content/index.js` as the stable Etsy integration
  surface for the current scraper contract. It may start background image
  analysis and listing synchronization, but must keep model/inference
  implementation in the background service worker and offscreen document.
- The `aid:analyze` response consumed by the content script must remain
  `{ ok: true, result: { score, label, threshold, modelVersion, imageId,
  processingTimeMs } }` on success and `{ ok: false, error }` on failure.
  Preserve the full structured result when routing model output; do not
  replace it with a bare score or a success-shaped fallback.
- Popup-triggered results may be routed back to the Etsy tab with
  `aid:show-result`; preserve the same structured result and apply it to every
  matching image element, not only the first DOM match.
- `extension/src/popup/` owns pasted-image analysis, current-page summaries,
  loading/error states, and accessible result display.
- The popup uses the merged tabbed UI exclusively:
  `scores-view` for listing scores, `auth-view` for sign-in/sign-up,
  `manual-view` for one-off image analysis, and `settings-view` for feature
  toggles. Do not reintroduce the legacy account panel, page-results panel,
  or legacy result card into `extension/src/popup/index.html` or
  `extension/src/popup/index.js`.
- `extension/src/popup/tabs-ui.js` owns the merged authentication and Scores
  presentation. Route listing scan state through the `rts:analysis-start`,
  `rts:analysis-progress`, `rts:analysis`, and `rts:scan-unavailable` events
  rather than rendering results in a second legacy UI. Description assessment
  state must use the live `scores-description-assessment` element and
  `rts:description-assessment` events, showing pending, available, and
  explicit failure or signed-out states. A successful login must retry the
  current listing scan so a prior signed-out assessment can be replaced with
  the authenticated result.
- Every assessment event rendered by `tabs-ui.js` must have a matching DOM
  element binding initialized before the listener is registered. Every
  assessment request declared in `extension/src/popup/index.js`, including
  seller-scoped trusted-creator lookup, must be invoked from the listing scan
  lifecycle and must dispatch a terminal available, unknown, unavailable, or
  error state; a placeholder such as "Checking…" must never remain solely
  because a request was defined but not called.
- Keep raw image detection separate from listing rating. Detection estimates
  AI likelihood; rating combines image evidence with carefully bounded listing
  signals.
- Maintain two explicit image sets in the Etsy content integration:
  - Listing evidence images are the current post's gallery images and review
    photos used by the listing scraper/rating payload.
  - Page-analysis images include every eligible Etsy-hosted product image on
    the page, including recommendations and related listings, so each can be
    independently tested for AI likelihood.
  Related/recommendation image results may receive badges and remain in the
  inference cache, but must never be included in the current listing's scraped
  rating data.
- Server-backed signals include trusted creators, Etsy user reviews, extension
  user reports, stored listing ratings, and per-image analysis scores. These
  are account-gated features and must use authenticated API requests, except
  for the temporary public score-sync paths documented below. The temporary
  `/api/scores` listing routes and `/api/scores/images` hash-only routes permit
  unauthenticated score reads and writes. Hash-only image records may contain
  only an image hash, normalized score, model metadata, optional URL, and
  timestamp; they must not require seller or listing metadata.
- Trusted-creator status is seller-scoped, never listing-scoped. Extract the
  current seller name from `[data-seller-cred-anchor]` and query the dedicated
  `/api/scores/trusted-creator/:username` route independently of the current
  listing ID. Compare the seller name case-insensitively with the existing
  quoted `"Username"` column in `score_snapshots`; do not change how that
  database value is stored. Treat only `trusted_creator_score === 1` as
  trusted. A matching `0`, `NULL`, missing row, or failed/unavailable server
  check must not be presented as trusted, and a failed check must remain
  distinct from a confirmed unknown seller.
- Prefer a fresh server-stored listing rating and matching per-image result
  over local cached or ONNX results, including for signed-out users through
  the temporary public score-read path. A server record with a missing or
  `NULL` aggregate, description score, or image result is incomplete: retain
  every valid server field, compute only the missing field locally, and retry
  the score submission when uploads are enabled. A missing server record,
  stale record, or unavailable server must fall back to local inference
  without blocking the scan.
- A signed-in user may read shared listing data and contribute reports. An
  unsigned user may use local image inference and the temporary public score
  read/write path, but must not access authenticated server features or AI
  description evaluation.
- Match stored image results by the SHA-256 image-byte hash, not by URL.
  Server image results must be checked before the local inference cache;
  matching results skip ONNX processing, while missing or stale images fall
  back to local inference.
- Page-wide images that are not part of the current listing must use the
  hash-only image-score path when synchronized. They may be looked up and
  stored without a listing ID, seller name, or listing score, and must never
  be added to the current listing's evidence set.
- Do not upload image bytes for server operations. Score submissions may
  include listing metadata, normalized scores, image hashes, and optional
  image URLs, but never image data. Any future remote image processing
  requires explicit opt-in and separate privacy documentation.
- Keep server-provided ratings distinguishable from fresh local image
  inference, and show which signals were used and when they were calculated.
- Listing analysis is background-first: the content script may send
  `aid:sync-listing` after local image results are available, so opening the
  popup must display or reuse existing work rather than trigger a second
  calculation.
- Local listing cache records must distinguish local-only results from
  server-synchronized results (for example with `source` and `serverSynced`).
  A fresh local record must not suppress a required server-upload retry.
- The popup must recover when an Etsy tab was already open during extension
  reload. With the manifest `scripting` permission, retry a missing
  `aid:collect-page` receiver by injecting the content script, then report an
  explicit unavailable error if injection is forbidden.
- Keep training datasets, checkpoints, and experimental training scripts out
  of the browser extension repository unless explicitly needed.
- Use `RateThatSlop` for user-facing branding, package metadata, release
  artifacts, and documentation. Keep implementation names and paths stable
  unless a technical rename is required.

## Model and Detection

- The bundled model is binary ONNX data; never edit it as text.
- The current model file is
  `extension/src/background/w5810_best_fp16.onnx`. Any inference code and
  build packaging must use the same filename consistently.
- The bundled ONNX model and vendored runtime files are shipped assets and
  must remain trackable; do not add them to ignore rules. The model exception
  in `.gitignore` must match `w5810_best_fp16.onnx`.
- Verify the model SHA-256 against `extension/model_manifest.json` before
  changing model metadata or calibration.
- `imageId` must be the SHA-256 hash of the fetched image bytes, calculated
  with the browser Web Crypto API in the offscreen document. Encode it
  compactly (base64url is preferred) and never use the full image URL or
  data URL as the image identity.
- Hashing and inference should share the same fetched `Blob` or byte buffer
  whenever possible; do not fetch each uncached image twice merely to hash it
  and then infer it. Release temporary image data after processing.
- Follow the manifest for input size, resize behavior, normalization,
  calibration, and test-time augmentation.
- Return structured results containing at least the score, label or confidence
  band, threshold, model version, and processing time.
- Distinguish inference failures from a low AI score; never use a successful
  zero score as an error fallback.
- Start with the Sieve model as a baseline. Do not tune final thresholds or
  calibration until a representative sewing-pattern validation set exists.
- Use low, uncertain, and high confidence bands rather than presenting one
  score as proof of deception.

## Listing Rating and Weighting

- Do not treat a new seller, missing metadata, or AI-looking imagery alone as
  proof of fraud or poor seller quality.
- Implement rating logic separately, preferably in
  `extension/src/background/rating.js`.
- Image evidence should be the dominant signal. Seller history and metadata
  should be weak, bounded contextual signals.
- Define the rating inputs and output reasons before optimizing weights.
- Tune weights only with labeled, manually reviewed Etsy examples and keep a
  held-out test set separate from calibration data.
- Measure precision, recall, F1, balanced accuracy, false-positive rate on
  real listings, and false-negative rate on AI-generated listings.

## Etsy Integration

- Support listing pages and search-result pages first.
- On listing pages, scope current-post gallery extraction to Etsy's listing
  gallery markers such as
  `.listing-page-image-carousel-component [data-palette-listing-image] img`
  and `[data-listing-image] img`. Scope customer-uploaded review photos to
  `[data-location="customer-photo-section"] img`. Do not use broad
  `data-palette-listing-image` selectors because Etsy also applies that marker
  to recommendation cards.
- Keep page-wide AI analysis separate from scraped listing evidence: analyze
  all eligible Etsy-hosted images, including related/recommended images, while
  excluding tracking pixels, avatars, icons, logos, and other utility images
  from the analyzable set.
- Deduplicate image URLs, ignore avatars/icons/logos, throttle requests, and
  cap automatic page scans at the current product decision limit of 100 images
  unless the user explicitly changes that limit. Keep a finite cap even when
  server-backed listing ratings later reduce local inference work.
- Automatic scans must account for Etsy's lazy-loaded and dynamically inserted
  images: perform an initial delayed scan, bounded follow-up scans, and a
  targeted `MutationObserver` for image additions or URL changes. Debounce
  rescans and cache completed image results so the same URL is not inferred
  repeatedly.
- The inference cache stores only compact result metadata and bounded keys;
  never retain downloaded image bytes, full `imageData` strings, or URL-based
  result identities. Persistent inference results must be keyed by the
  SHA-256 hash of the fetched image bytes.
- Page scans must batch-check all candidate image URLs against the cache before
  starting any uncached inference. Keep persistent cache hits separate from
  the uncached processing queue, and prevent overlapping delayed scans from
  starting duplicate work.
- Batch hashing and inference must use bounded concurrency and explicit
  per-image error handling; one unavailable or invalid image must not abort
  the complete page scan or create unbounded simultaneous fetches.
- Do not rescan the entire page for every mutation, and do not assume the DOM
  is complete at `document_idle`.
- Treat title, seller, review count, price, and listing URL as optional
  metadata because Etsy's DOM can change.
- Prefer Etsy-specific selectors when available, including
  `[data-seller-cred-anchor]`, `.wt-text-title-larger`, and
  `[data-product-details-description-text-content]`; keep fallbacks narrow
  enough to avoid navigation, recommendation, advertisement, and badge text.
- A listing page is only a page whose Etsy host pathname matches
  `/listing/<numeric-id>`; do not scrape search, shop, market, or lookalike
  paths.

### Etsy listing-page organization reference

- The listing URL and numeric ID identify the current post. Prefer the
  `/listing/<numeric-id>` path and stable listing IDs over query parameters,
  referral codes, or image URLs.
- The main product gallery is contained by
  `.listing-page-image-carousel-component`. Its product panes use
  `[data-palette-listing-image]` or `[data-listing-image]`, with image IDs in
  `data-image-id` and product-image URLs in `src`, `srcset`,
  `data-src-zoom-image`, or the overlay's `data-delay-src`.
- The seller link uses `[data-seller-cred-anchor]`. The visible creator name
  is the link text; the shop URL and referral query parameters are contextual
  metadata, not the creator identity.
- The price is displayed in `.wt-text-title-larger`; remove the
  screen-reader `Price:` prefix before storing it.
- The product details section uses
  `[data-product-details-description-text-content]`. It can contain
  description, instructions, sizing, materials, links, disclaimers, and
  contact text. Treat this as product information rather than as review text.
- Review summary data is grouped under `.reviews-header-ratings`, including
  the item average, review count, item quality, shipping, customer service,
  and buyer-recommendation values.
- Individual reviews are separate from the summary and may include review
  text, star values, reviewer metadata, dates, and purchase photos. Customer
  photos are marked with
  `[data-location="customer-photo-section"]`.
- Related products, shop recommendations, visual-search cards, and related
  searches occur elsewhere on the page. They commonly reuse Etsy listing
  markers such as `data-palette-listing-image`, so they must not be confused
  with the current product gallery.
- Etsy adds badges, navigation, advertisements, loading controls, tracking
  pixels, and recommendation content to the same document. Avoid broad
  selectors such as all `ul`, all `.details`, or all page images when
  extracting listing data.
- Sections may be lazy-loaded or changed by client-side rendering. Use narrow
  selectors, bounded delayed scans, and targeted mutation handling rather than
  assuming the initial DOM contains the complete listing.
- Badges must use text as well as color, include loading and unavailable
  states, apply to all matching image elements, and make clear that results
  are automated estimates.
- Image badges belong in the bottom-left of the rendered image. Etsy listing
  carousel panes can be larger than a centered image, so calculate overlay
  offsets from the image's rendered bounds relative to its positioned host
  rather than assuming the host and image have identical dimensions. Avoid
  the top corners, which Etsy uses for listing and favorite badges, and the
  bottom-right, which may contain video controls.

## Build and Test

- Node.js and npm are developer/build prerequisites only. End users should
  receive a packaged or Chrome Web Store extension and must not need Node.js,
  npm, Python, an API key, or a separate inference server.
- Run commands from `extension/`.
- Install dependencies with `npm install` or `npm ci`.
- Build with `npm run build`.
- Run tests with `npm test`.
- Validate manifest paths and model presence after building.
- The current inference implementation explicitly uses ONNX Runtime's WASM
  execution provider. Test that path; add WebGPU coverage only after a
  WebGPU execution-provider path is implemented.
- Add tests for preprocessing, calibration, invalid images, Etsy DOM
  extraction, deduplication, dynamic/lazy-loaded listings, repeated image
  badge routing, popup assessment request/event completion, popup states, and
  rating boundaries.
- Do not claim the extension is complete while the model, offscreen runtime,
  popup, or Etsy content script is still a placeholder.

### Browser smoke test

- Run `npm install`, `npm test`, and `npm run build` from `extension/`.
- Load the `extension/` directory in Chrome through `chrome://extensions` >
  **Developer mode** > **Load unpacked**. After changes, use the extension's
  **Reload** button before testing.
- Use the extension popup for the primary manual model test. Paste a direct
  image URL, such as an `i.etsystatic.com` image URL, and click **Analyze
  image**. The result should include the AI likelihood, label, threshold,
  model version, and processing time.
- Test the service worker and offscreen runtime through the popup flow rather
  than sending `chrome.runtime.sendMessage` from the service worker's own
  console; that console is not a reliable receiving context for the service
  worker's message listener.
- Treat the score as a calibrated automated estimate, not proof that an image
  is AI-generated, fraudulent, or evidence of poor seller quality. The first
  inference may be slower because ONNX Runtime and the model session are
  initialized; later requests should reuse the loaded session.
- For distribution, package the built contents of `extension/` without
  `node_modules/`; retain `manifest.json`, the model, `model_manifest.json`,
  popup files, and `vendor/ort/`. Prefer Chrome Web Store distribution for
  low-setup installation and automatic updates.

## Privacy and Documentation

- Update `README.md` and create or maintain `PRIVACY.md` when behavior changes.
- Document model provenance, model version, thresholds, known limitations, and
  whether any image or listing metadata leaves the browser.
- Document authentication, server endpoints, data minimization, retention,
  account deletion, report moderation, and the seven-day server listing-cache
  freshness policy whenever server behavior changes.
- Preserve required licenses and attribution for Sieve code, ONNX Runtime,
  model weights, and copied assets.

## Temporary Hackathon Fixes

These are deliberate demo-only compromises to keep the end-to-end
score-saving path working during the hackathon. Do not treat them as the
production security or privacy design.

- Score reads and score submissions under `/api/scores` are temporarily
  available without a signed-in extension session. The extension may send
  listing metadata, normalized scores, image hashes, and optional image URLs
  without an access token.
- The Supabase migration
  `backend/database/migrations/001_hackathon_public_score_access.sql`
  temporarily grants public `anon` and `authenticated` read/write access to
  `patterns`, `score_snapshots`, and `image_analyses`, with permissive RLS
  policies. Keep the migration idempotent and apply it explicitly to the
  deployed project; changing `backend/database/schema.sql` alone does not
  update Supabase.
- This temporary path still must never upload image bytes, full image data
  URLs, passwords, access tokens, service-role keys, or Gemini secrets.
  Validate score ranges, cap submissions at 100 images, and store hashes
  rather than image data.
- `serverUploadEnabled` still gates score writes at the extension operation
  boundary. A disabled setting must skip or reject the operation explicitly;
  it must not send the request and ignore the result.
- Description evaluation, reports, reviews, diagnostics, account operations,
  and other non-score server features remain authenticated unless the user
  explicitly requests another hackathon-only change.
- Before a public production release, replace this temporary design with
  authenticated score reads and writes, restrictive RLS policies scoped to
  the requesting user or approved shared-data model, abuse/rate limiting,
  server-side authorization and ownership checks, migration verification,
  audit logging, and tests for unauthorized reads/writes. Remove the public
  grants and policies only after the authenticated client flow is verified.

## Server Integration

- `extension/src/background/api-client.js` owns requests to the RateThatSlop
  server and must centralize authorization where required, response
  validation, timeout handling, and explicit error propagation. During the
  hackathon, score reads/submissions are the documented unauthenticated
  exception; description evaluation, reports, reviews, and diagnostics remain
  authenticated.
- `extension/src/background/auth.js` owns the stored access-token session and
  expiry handling. Never log credentials or access tokens. Do not make local
  image inference depend on server availability.
- The merged popup authenticates against the configured Supabase project after
  checking the deployed RateThatSlop API health endpoint. The production API
  base URL is
  `https://rate-my-slop-xzld5.ondigitalocean.app`; do not default the merged
  login flow to localhost. Scanning and local image inference must continue to
  work when this server or Supabase is unavailable.
- `aid:sign-in` and `aid:sign-up` are background message operations. Auth
  responses must preserve explicit errors, store only the access-token session
  metadata, and never expose or log passwords, secret keys, or tokens.
- `backend/server.js` must load `backend/.env` with dotenv for local server
  execution. `backend/.env` is ignored and must never be committed or copied
  into the extension; only the Supabase URL and publishable key may be used
  to generate the extension's public build configuration.
- Backend database access must use the Supabase server secret/service-role
  credential, configured only as `SUPABASE_SERVICE_ROLE_KEY` or the supported
  legacy `SUPABASE_KEY`; never use a publishable/anon key for server writes.
  Supabase secret keys may use a non-JWT format, so do not treat failure to
  decode a key locally as proof that it is invalid. Verify it with a
  read-only table check and a controlled write test for the applicable route
  instead.
- Keep the user access token and backend database credential distinct. A
  successful authenticated route such as description evaluation proves the
  user token is accepted, but does not prove that the backend service
  credential can write database rows. Conversely, a database-read failure
  does not justify changing the extension's user session.
- `extension/src/background/listing-cache.js` owns local caching of server
  listing records and ratings. Cache keys use `etsy:<numeric-listing-id>`,
  never an image URL or unnormalized page URL. Image-byte hashes identify
  analyzed image files and must not be treated as listing identities. Cached
  records are valid for seven days and must be cleared on logout. Preserve
  server provenance and synchronization state when writing cached records.
  Do not coerce server `NULL` values through `Number(null)`; preserve them as
  `null` so the caller can distinguish an incomplete server result from a
  valid zero score.
- `extension/src/popup/auth-ui.js` owns login and account controls when that
  UI is implemented; it must expose signed-out and server-unavailable states
  accessibly.
- `extension/src/background/settings.js` owns feature-toggle definitions,
  default values, and persistence. Store toggle values in
  `chrome.storage.local`; an absent value means enabled for backward
  compatibility. The popup owns only presentation and sends `aid:get-settings`
  and `aid:set-settings` messages to the background service worker.
- The popup must expose separate, accessible toggles for scraping,
  server-score uploads, shared server information, AI description testing,
  extension user reviews, and Etsy reviews. All six default to enabled.
- Enforce toggles at the operation boundary, not only by hiding UI controls:
  `scrapingEnabled` gates automatic and manual Etsy scraping,
  `serverUploadEnabled` gates score and user-review writes,
  `serverInfoEnabled` gates shared listing/server reads,
  `descriptionAiEnabled` gates description evaluation,
  `userReviewsEnabled` gates user-review reads and writes, and
  `etsyReviewsEnabled` excludes Etsy review text, ratings, and customer-review
  photos from scraping. Keep local image inference independent of these
  settings.
- Settings must enforce operation boundaries. During the hackathon,
  `serverUploadEnabled` may permit unauthenticated score writes, and
  `serverInfoEnabled` may permit unauthenticated reads for the temporary
  `/api/scores` listing-score and `/api/scores/images` hash-only paths. Other
  server-related toggles must still
  require a valid signed-in session.
  Disabling a toggle must prevent the corresponding request rather than
  sending it and ignoring the response. Return explicit errors or skipped
  statuses for disabled operations.
- Backend server routes are mounted in `backend/server.js`: score reads and
  writes are under `/api/scores` and are temporarily unauthenticated for the
  hackathon; description evaluation is under `/api/evaluate-description`
  (with the `/api/descriptions` route retained as a compatible route group),
  and reports remain under `/api/reports`.
  The seller-only trusted-creator lookup is part of the temporary public score
  read path. It must search all matching seller rows and select a stored trust
  value of exactly `1` when any matching row has one; do not rely on a single
  listing snapshot or database null ordering. Preserve the response's checked
  state and explicit `null` value when no usable trust flag exists.
  Description evaluation remains authenticated and returns the structured AI
  assessment for the popup, including the evaluator's 0-100 value, a
  normalized `descriptionScore` in the 0-1 interval, and a cleaned
  `descriptionRationale` without a duplicated `10/100`-style prefix.
  Preserve explicit non-JSON/error responses when diagnosing deployment
  problems. Keep server responses structured so the UI can display the
  overall score, per-image scores, description rationale, source,
  model/scoring versions, reasons, and calculation timestamps.
- Backend score and hash-only image writes must validate numeric scores to the
  unit interval,
  cap submissions at 100 images, and store image hashes rather than image
  bytes. Score snapshots store `description_score` and
  `description_rationale`; listing image rows belong to the inserted
  snapshot, while page-wide hash-only image rows belong to the standalone
  image-score table. Database constraints and validation must remain aligned.
- Applying `backend/database/schema.sql` to a local checkout does not update
  an existing Supabase project automatically. When schema fields change,
  provide and apply an explicit Supabase SQL migration such as
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, then verify the live columns
  before diagnosing missing data as a client-cache issue.
- When changing trusted-creator lookup routes, redeploy the backend before
  diagnosing extension behavior. Verify the deployed
  `/api/scores/trusted-creator/<seller-name>` response directly and test at
  least two listings from the same seller; a `401`, `404`, listing-only
  response, or a response missing `"Username"`/`trusted_creator_score`
  indicates that the deployed service is stale or misconfigured.
- Before diagnosing score/report writes, run the backend locally with the
  ignored `backend/.env` and perform read-only checks against `/api/health`,
  `/api/test-db`, and each application table. Then perform one controlled
  score write using non-sensitive test metadata when validating the hackathon
  path. Do not print credentials. A `200` health response only proves the HTTP
  process is alive; a `500` from a write route requires the server's
  underlying Supabase error from deployment logs.
- Preserve the distinction between expected score cache misses (`404 Pattern
  not found`), invalid user authentication (`401`), database/write failures
  (`500`), and hosting/database timeouts (`504`, often non-JSON HTML). Do not
  log expected cache misses as failures or replace actionable upstream errors
  with a generic success-shaped response.
- Keep server feature tests in `extension/test/api-client.test.js`,
  `extension/test/auth.test.js`, and
  `extension/test/listing-cache.test.js`.
- Do not add credentials or tokens to source-controlled configuration. Backend
  secrets remain in the ignored `backend/.env`; use
  `backend/.env.example` for placeholders only. The extension may contain the
  deployed public API URL and Supabase publishable key, but never a Supabase
  secret key, Gemini key, password, or access token.
