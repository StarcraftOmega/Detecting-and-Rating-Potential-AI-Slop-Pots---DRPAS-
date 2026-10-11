# RateThatSlop

RateThatSlop is a Manifest V3 Chrome extension that estimates whether Etsy
sewing-pattern listing images may be AI-generated. Inference runs locally in
the browser using the bundled ONNX model.

The authenticated server provides shared listing ratings, per-image analysis
scores, trusted creator information, Etsy review data, extension user
reports, and AI evaluation of listing text. Unsigned users remain local-only
and cannot read or write server data or request description evaluation.

## Development

Run these commands from [`extension/`](./extension/):

```powershell
npm install
npm test
npm run build
```

The extension build reads only `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY` from `backend/.env` and writes them to a
gitignored generated config, using the bundled public project config when
either value is absent. The extension also uses that bundled config if the
generated file is missing in a packaged copy. `SUPABASE_KEY` is never read by
the extension build. The popup asks only for the API server URL; for a hosted
HTTPS API, Chrome requests permission for that origin when you sign in.

The tests cover Etsy host validation, image deduplication/filtering, and
listing metadata extraction. The build vendors the local ONNX Runtime files
needed by the offscreen inference document.

## Using the Etsy scraper

1. Build the extension and load [`extension/`](./extension/) as an unpacked
   extension at `chrome://extensions`.
2. After every rebuild, click the extension's **Reload** button, then reload
   the Etsy tab itself. Content scripts are injected into a tab only when that
   page loads.
3. Open the RateThatSlop popup and choose **Scan current Etsy page**.
4. The popup lists each suitable product image it found and its local AI
   likelihood. When a description is available, the Scores view shows that
   the description was submitted while the AI review is in progress, then
   shows the returned AI-writing likelihood and classification. If the
   server or model is unavailable, the view reports that failure instead of
   displaying a misleading score. Direct image URLs can still be analyzed
   individually.

The scraper deduplicates image URLs, ignores common avatars/icons/logos, caps
scans at 100 images, and extracts title, seller, price, and page URL when the
Etsy DOM exposes them. The cap prevents an unexpectedly large page from
triggering unbounded local inference. Etsy can change its markup, so missing
metadata is expected and does not prevent image analysis.

The popup's **Feature settings** switches are enabled by default for scraping,
server score uploads, shared server information, AI description testing, user
reviews, and Etsy reviews. Turning a switch off prevents that operation; local
image inference remains available. Server operations also require a signed-in
RateThatSlop account regardless of the switch state.

When a listing page is opened, three bounded scrapers collect listing identity,
product instructions/details, and review/rating/image inputs. Scraping can be
disabled with the `scrapingEnabled` extension-storage setting. A listing is
skipped when its listing ID is already marked in the local post cache. The
cache stores the creator, price, URL, name, image-byte hashes, and an optional
structured AI rating; raw description and review text is passed only to the
processing boundary and is not persisted by the extension. Automatic
description evaluation is enabled by default and can be disabled with the
popup checkbox. When enabled and signed in, the description plus listing title,
price, instructions, and attributes are sent to the authenticated server for
AI evaluation. Review text and image bytes are not included.

Completed image-inference results are stored as compact metadata in the
extension's local cache, keyed by the SHA-256 hash of the fetched image
bytes rather than by an image URL. A page scan hashes all candidate images
and checks those hashes for cached results before starting new local
inference, so URL changes and service-worker restarts do not force the same
image to be reprocessed.

The extension requests Etsy CDN host access because product images are commonly
served from `i.etsystatic.com`, not `etsy.com`. Images are fetched by the
local offscreen inference document and are not uploaded to a remote service.
In the server-backed flow, a signed-in user can download a fresh stored rating
for a known listing. Each image is matched by its local SHA-256 image-byte hash;
matching server results are shown without running local inference, while
missing or stale results fall back to local inference. Server records are
cached for seven days. Image inference remains local and image bytes are never
uploaded by these APIs.

The initial local inference runtime and model manifest were copied from the
Sieve image detector project. The original project is available at
https://github.com/Phineas1500/sieve-ai-image-detector.

See [`PRIVACY.md`](./PRIVACY.md) for the data flow and limitations.

## Backend API

The server implementation is in [`backend/`](./backend/). Start it from that
directory after configuring `SUPABASE_URL` and `SUPABASE_KEY` in
`.env`:

```powershell
npm install
npm start
```

Routes are grouped by responsibility:

- `GET /api/health` and `GET /api/test-db` are health checks.
- `GET /api/me` returns the authenticated Supabase user.
- `GET /api/patterns/:platform/:listingId` retrieves a listing record.
- `GET /api/scores/:platform/:listingId` retrieves the latest stored score and
  its image analyses.
- `POST /api/scores` stores a listing identity, overall signal scores, and
  compact per-image scores. It accepts hashes and optional URLs, never image
  bytes.
- `POST /api/descriptions/evaluate` evaluates description text with AI and
  optional title, price, instructions, and attributes; authentication is
  required.
- `GET /api/reports/:platform/:listingId` and `POST /api/reports` provide
  authenticated report access and submission.

Report submissions create the listing record when necessary and upsert one
report per authenticated user and listing. Report and score endpoints never
accept or upload image bytes.
