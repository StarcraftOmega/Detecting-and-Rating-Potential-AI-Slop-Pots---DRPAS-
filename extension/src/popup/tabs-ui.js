// Scores, Supabase authentication, and local Settings preferences.
import { showView } from "./navigation.js";


const $ = (selector) => document.querySelector(selector);
const scoresEmpty = $("#scores-empty");
const scoresData = $("#scores-data");
const scoresImages = $("#scores-images");
const scoresHeading = $("#scores-heading");
const descriptionAssessment = $("#scores-description-assessment");
const reviewsAssessment = $("#scores-reviews-assessment");
//const scoresSummary = $("#scores-summary");

const retryButton = $("#scores-retry");
retryButton.addEventListener("click", () => {
  $("#scores-empty-message").textContent = "Scanning this listing…";
  document.dispatchEvent(new Event("rts:scan-requested"));
});
document.addEventListener("rts:scan-unavailable", (event) => {
  if (scoresData.hidden) {
    $("#scores-empty-message").textContent = event.detail.message;
    scoresEmpty.hidden = false;
  }
});

// Display Etsy thumbnails immediately, then update each score as ONNX finishes.
let currentImages = [];
let currentListingScore = null;

function createScoreCard(item, index) {
  const card = document.createElement("article");
  card.className = "score-image-card";
  const photo = document.createElement("div");
  photo.className = "score-image-photo";
  const img = document.createElement("img");
  img.src = item.url;
  img.alt = item.alt || `Image ${index + 1}`;
  img.loading = "lazy";
  const rating = document.createElement("span");
  rating.className = "score-image-overlay";
  rating.textContent = item.result && Number.isFinite(Number(item.result.score))
    ? `${(Number(item.result.score) * 100).toFixed(1)}% AI`
    : (item.status || "Waiting…");
  const caption = document.createElement("p");
  caption.textContent = `Image ${index + 1}`;
  photo.append(img, rating);
  card.append(photo, caption);
  return card;
}

function listingImagesOnly() {
  return currentImages.filter((item) => item.listingEvidence === true);
}

function renderListingImages() {
  scoresImages.replaceChildren(
    ...listingImagesOnly().map((item, index) => createScoreCard(item, index)),
  );
}

// Same image-only aggregation formula as background/rating.js:
// 60% mean score + 40% 90th-percentile score.
// Kept in the popup to avoid a background-module import stopping the UI.
function updateScoreSummary() {
  const scores = currentImages
    .filter((item) => item.listingEvidence !== false)
    .map((item) => item?.result?.score)
    .filter((score) =>
      typeof score === "number" &&
      Number.isFinite(score) &&
      score >= 0 && score <= 1
    )
    .sort((a, b) => a - b);

  if (scores.length === 0) {
    scoresHeading.textContent = "—";
    return;
  }

  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const position = (scores.length - 1) * 0.90;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const highRisk = scores[lower] +
    (scores[upper] - scores[lower]) * (position - lower);
  const aggregate = mean * 0.60 + highRisk * 0.40;

  scoresHeading.textContent = `${(aggregate * 100).toFixed(1)}%`;
}

document.addEventListener("rts:analysis-start", (event) => {
  currentImages = event.detail.images.map((item) => ({ ...item }));
  currentListingScore = event.detail.listingScore || null;
  scoresEmpty.hidden = true;
  scoresData.hidden = false;
  renderDescriptionAssessment(event.detail.descriptionAssessment);
  renderReviewsAssessment(event.detail.reviewsAssessment);
  //scoresHeading.textContent = event.detail.title;
  renderListingImages();
  updateScoreSummary();
});

function renderDescriptionAssessment(assessment) {
  if (!descriptionAssessment || !assessment) return;
  if (assessment.status === "pending") {
    descriptionAssessment.textContent = assessment.message;
    return;
  }
  if (assessment.status === "error") {
    descriptionAssessment.textContent = `Description review failed: ${assessment.message}`;
    return;
  }
  if (assessment.status !== "available") {
    descriptionAssessment.textContent = assessment.message || "No listing description was available to review.";
    return;
  }
  const result = assessment.result || {};
  const score = Number(result.ai_likeness_score);
  const classification = typeof result.classification === "string"
    ? result.classification
    : "assessment complete";
  const rawRationale = typeof result.descriptionRationale === "string"
    ? result.descriptionRationale : result.overall_rationale;
  const rationale = typeof rawRationale === "string"
    ? ` ${rawRationale.replace(/^\s*AI-writing likelihood:\s*\d+\s*\/\s*100(?:\s*\([^)]*\))?\.\s*/i, "").trim()}`
    : "";
  descriptionAssessment.textContent =
    `AI-writing likelihood: ${score.toFixed(0)}/100 (${classification}).${rationale}`;
}

document.addEventListener("rts:description-assessment", (event) => {
  renderDescriptionAssessment(event.detail);
});

function renderReviewsAssessment(assessment) {
  if (!reviewsAssessment || !assessment) return;
  if (assessment.status === "pending") {
    reviewsAssessment.textContent = assessment.message;
    return;
  }
  if (assessment.status === "error") {
    reviewsAssessment.textContent = `Reviews assessment failed: ${assessment.message}`;
    return;
  }
  if (assessment.status !== "available") {
    reviewsAssessment.textContent = assessment.message || "No review information was available to assess.";
    return;
  }
  const result = assessment.result || {};
  const textAssessment = result.review_text_ai_assessment || {};
  const score = Number(textAssessment.ai_likeness_score);
  if (!Number.isFinite(score)) {
    reviewsAssessment.textContent = "Reviews assessment returned an invalid AI-likelihood score.";
    return;
  }
  const classification = typeof textAssessment.classification === "string"
    ? textAssessment.classification
    : "assessment complete";
  const rationale = typeof textAssessment.score_rationale === "string"
    ? textAssessment.score_rationale
    : typeof result.overall_rationale === "string"
      ? result.overall_rationale
      : "";
  reviewsAssessment.textContent =
    `Review-text AI-likelihood: ${score}/100 (${classification}). ${rationale}`.trim();
}

document.addEventListener("rts:reviews-assessment", (event) => {
  renderReviewsAssessment(event.detail);
});

document.addEventListener("rts:analysis-progress", (event) => {
  const { index, item } = event.detail;
  currentImages[index] = item;
  renderListingImages();
  updateScoreSummary();
});

document.addEventListener("rts:analysis", (event) => {
  if (event.detail.type !== "listing") return;
  currentImages = event.detail.images;
  currentListingScore = event.detail.listingScore || null;
  scoresEmpty.hidden = true;
  scoresData.hidden = false;
  renderReviewsAssessment(event.detail.reviewsAssessment);
  //scoresHeading.textContent = event.detail.title;
  renderListingImages();
  updateScoreSummary();
});

document.addEventListener("rts:server-upload-failed", (event) => {
  const message = event.detail?.message || "Server upload failed.";
  authFeedback.textContent = /sign-in is required/i.test(message)
    ? "This scan was kept locally. Sign in again before uploading scores."
    : `Score upload failed: ${message}`;
});

let authMode = "login";
const authForm = $("#auth-form");
const authHeading = $("#auth-heading");
const authIntro = $("#auth-intro");
const authSubmit = $("#auth-submit");
const authSwitch = $("#auth-switch");
const authSignedIn = $("#auth-signed-in");
const authSignedInMessage = $("#auth-signed-in-message");
const authSignOut = $("#auth-sign-out");
const authFeedback = $("#auth-feedback");
const password = $("#auth-password");
const settingsNote = $("#settings-note");
// TEMP: Use http://localhost:3000 here when testing the local backend.
const apiServerUrl = "https://rate-my-slop-xzld5.ondigitalocean.app";
const diagnosticOutput = $("#diagnostic-output");
const deployedServerUrl = "https://rate-my-slop-xzld5.ondigitalocean.app";

function sendBackgroundMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function setSettingsEnabled(enabled) {
  document.querySelectorAll("[data-setting]").forEach((control) => {
    control.disabled = !enabled;
    control.closest(".setting-row")?.classList.toggle("locked", !enabled);
  });

  settingsNote.textContent = enabled
    ? "Settings are available for this signed-in session."
    : "Log in to unlock settings.";
}

$("#server-check").addEventListener("click", async () => {
  diagnosticOutput.hidden = false;
  diagnosticOutput.textContent = "Running authenticated server checks…";
  try {
    const response = await sendBackgroundMessage({ kind: "aid:run-server-diagnostics" });
    diagnosticOutput.textContent = response?.ok
      ? JSON.stringify(response.diagnostics, null, 2)
      : `Server checks failed: ${response?.error || "unknown error"}`;
  } catch (error) {
    diagnosticOutput.textContent = `Server checks failed: ${error.message}`;
  }
});

$("#view-logs").addEventListener("click", async () => {
  diagnosticOutput.hidden = false;
  try {
    const response = await sendBackgroundMessage({ kind: "aid:get-diagnostics" });
    diagnosticOutput.textContent = response?.ok && response.logs.length
      ? response.logs.map((entry) =>
        `[${entry.at}] ${entry.event} ${entry.details ? JSON.stringify(entry.details) : ""}`,
      ).join("\n")
      : response?.ok ? "No diagnostic logs." : `Could not read logs: ${response?.error || "unknown error"}`;
  } catch (error) {
    diagnosticOutput.textContent = `Could not read logs: ${error.message}`;
  }
});

$("#clear-cache").addEventListener("click", async () => {
  diagnosticOutput.hidden = false;
  try {
    const response = await sendBackgroundMessage({ kind: "aid:clear-cache" });
    diagnosticOutput.textContent = response?.ok
      ? `Cleared ${response.removed} local cache entries and diagnostic logs.`
      : `Could not clear cache: ${response?.error || "unknown error"}`;
  } catch (error) {
    diagnosticOutput.textContent = `Could not clear cache: ${error.message}`;
  }
});

async function configureServer() {
  const configured = await sendBackgroundMessage({
    kind: "aid:configure-server",
    serverBaseUrl: apiServerUrl,
  });
  if (!configured?.ok) throw new Error(configured?.error || "Could not configure the API server.");
  const setup = await sendBackgroundMessage({ kind: "aid:check-sign-in-setup" });
  if (!setup?.ok) throw new Error(setup?.error || "Sign-in setup check failed.");
}

async function loadAuthState() {
  const response = await sendBackgroundMessage({ kind: "aid:get-auth-state" });
  if (!response?.ok) throw new Error(response.error || "Could not read sign-in state.");
  if (response.user) {
    showSignedInState(response.user.email);
    document.dispatchEvent(new Event("rts:scan-requested"));
  } else {
    showSignedOutState();
    setSettingsEnabled(false);
  }
}

function updateAuthMode() {
  const registering = authMode === "signup";
  authHeading.textContent = registering ? "Create account" : "Log in";
  authSubmit.textContent = registering ? "Sign up" : "Log in";
  authSwitch.textContent = registering ? "Already have an account? Log in" : "Need an account? Sign up";
  password.autocomplete = registering ? "new-password" : "current-password";
  authFeedback.textContent = "";
}

function showSignedOutState() {
  authMode = "login";
  authForm.reset();
  authHeading.textContent = "Log in";
  authIntro.hidden = false;
  authForm.hidden = false;
  authSignedIn.hidden = true;
  authSignedInMessage.textContent = "";
  reportLoginButton.hidden = false;
  authSignOut.disabled = false;
  authSubmit.disabled = false;
  authSwitch.hidden = false;
  updateAuthMode();
}

function showSignedInState(email) {
  authHeading.textContent = "Account";
  authIntro.hidden = true;
  authForm.hidden = true;
  authSwitch.hidden = true;
  authSignedIn.hidden = false;
  authSignedInMessage.textContent = `You are signed in${email ? ` as ${email}` : ""}.`;
  authFeedback.textContent = "";
  reportLoginButton.hidden = true;
  setSettingsEnabled(true);
}

authSwitch.addEventListener("click", () => {
  authMode = authMode === "login" ? "signup" : "login";
  authForm.reset();
  updateAuthMode();
});
authForm.addEventListener("submit", (event) => {
  event.preventDefault();
  authSubmit.disabled = true;
  authFeedback.textContent = authMode === "signup" ? "Creating account…" : "Signing in…";
  const email = $("#auth-email").value.trim();
  const passwordValue = password.value;
  const kind = authMode === "signup" ? "aid:sign-up" : "aid:sign-in";
  configureServer()
    .then(() => sendBackgroundMessage({ kind, email, password: passwordValue }))
    .then((response) => {
      if (!response?.ok) throw new Error(response?.error || "Authentication failed.");
      password.value = "";
      if (authMode === "signup" && response.requiresEmailConfirmation) {
        authFeedback.textContent = "Account created. Check your email to confirm it, then log in.";
        authSubmit.disabled = false;
        return;
      }
      showSignedInState(response.user?.email || email);
      document.dispatchEvent(new Event("rts:scan-requested"));
    })
    .catch((error) => {
      authFeedback.textContent = error.message;
      authSubmit.disabled = false;
    });
});

authSignOut.addEventListener("click", async () => {
  authSignOut.disabled = true;
  authFeedback.textContent = "Signing out…";
  try {
    const response = await sendBackgroundMessage({ kind: "aid:sign-out" });
    if (!response?.ok) throw new Error(response?.error || "Could not sign out.");
    showSignedOutState();
    authFeedback.textContent = "Signed out.";
    setSettingsEnabled(false);
  } catch (error) {
    authFeedback.textContent = error.message;
    authSignOut.disabled = false;
  }
});

document.querySelectorAll("[data-setting]").forEach((control) => {
  control.addEventListener("change", async () => {
    try {
      const response = await sendBackgroundMessage({
        kind: "aid:set-settings",
        settings: { [control.dataset.setting]: control.checked },
      });
      if (!response?.ok) throw new Error(response?.error || "Could not save setting.");
    } catch (error) {
      control.checked = !control.checked;
      authFeedback.textContent = error.message;
    }
  });
});

setSettingsEnabled(false);
loadAuthState().catch((error) => {
  authFeedback.textContent = error.message;
});

// The scanner is guest-accessible and runs on an Etsy listing at popup start.
document.dispatchEvent(new Event("rts:scan-requested"));
