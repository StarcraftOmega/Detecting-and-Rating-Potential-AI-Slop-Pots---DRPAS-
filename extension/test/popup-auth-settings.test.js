import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const popupHtml = await readFile(
  new URL("../src/popup/index.html", import.meta.url),
  "utf8",
);
const tabsUi = await readFile(
  new URL("../src/popup/tabs-ui.js", import.meta.url),
  "utf8",
);
const popupIndex = await readFile(
  new URL("../src/popup/index.js", import.meta.url),
  "utf8",
);

test("merged popup keeps the sign-up switch and settings controls", () => {
  assert.match(popupHtml, /id="auth-switch"[^>]*>Need an account\? Sign up</);
  assert.match(popupHtml, /id="settings-view"/);
  assert.equal((popupHtml.match(/data-setting="/g) || []).length, 6);
});

test("merged auth UI does not reference removed legacy login controls", () => {
  assert.doesNotMatch(tabsUi, /\breportLoginButton\b/);
});

test("manual listing scans refresh cached seller-related assessments", () => {
  assert.match(popupIndex, /requestDescriptionAssessment\(listing, listingScore, \{ forceRefresh \}\)/);
  assert.match(popupIndex, /requestReviewsAssessment\(listing, \{ forceRefresh \}\)/);
  assert.match(
    popupIndex,
    /if \(!forceRefresh && cached\[cacheKey\]\?\.fingerprint === descriptionFingerprint\(description\)/,
  );
  assert.match(
    popupIndex,
    /if \(!forceRefresh && cached\[cacheKey\]\?\.fingerprint === fingerprint\)/,
  );
});
