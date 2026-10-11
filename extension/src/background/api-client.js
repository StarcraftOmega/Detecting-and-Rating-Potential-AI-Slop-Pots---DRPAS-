import { getAccessToken } from "./auth.js";
import { writeDiagnostic } from "./diagnostics.js";

const SERVER_URL_KEY = "serverBaseUrl";
const DEFAULT_SERVER_URL = "https://rate-my-slop-xzld5.ondigitalocean.app";
const DEFAULT_TIMEOUT_MS = 8000;

function validateObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} response was malformed`);
  }
  return value;
}

export function createApiClient({
  baseUrl,
  getToken = getAccessToken,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  async function configuredBaseUrl() {
    if (baseUrl) return baseUrl.replace(/\/+$/, "");
    const stored = await chrome.storage.local.get(SERVER_URL_KEY);
    const configured = typeof stored[SERVER_URL_KEY] === "string"
      ? stored[SERVER_URL_KEY].trim()
      : "";
    return (configured || DEFAULT_SERVER_URL).replace(/\/+$/, "");
  }

  async function request(path, options = {}) {
    const method = options.method || "GET";
    const token = await getToken();
    if (options.requireAuth !== false && !token) {
      throw new Error("sign-in is required for server features");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${await configuredBaseUrl()}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(options.headers || {}),
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
      });
      let body;
      try {
        body = await response.json();
      } catch {
        const contentType = response.headers.get("content-type") || "unknown content type";
        throw new Error(`server returned invalid JSON (HTTP ${response.status}, ${contentType}); redeploy the backend if this endpoint is missing`);
      }
      if (response.status === 404 && options.allowNotFound) {
        await writeDiagnostic("server-resource-miss", { method, path, status: response.status });
        return null;
      }
      if (!response.ok) {
        await writeDiagnostic("server-request-failed", {
          method,
          path,
          status: response.status,
          error: typeof body.error === "string" ? body.error : "unknown server error",
        });
        throw new Error(typeof body.error === "string" ? body.error : `server request failed (${response.status})`);
      }
      await writeDiagnostic("server-request-succeeded", { method, path, status: response.status });
      return validateObject(body, "server");
    } catch (error) {
      if (error.name === "AbortError") throw new Error("server request timed out");
      await writeDiagnostic("server-request-error", { method, path, error: error.message });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    getListingScore(platform, listingId, username = "") {
      const query = typeof username === "string" && username.trim()
        ? `?username=${encodeURIComponent(username.trim())}` : "";
      return request(`/api/scores/${encodeURIComponent(platform)}/${encodeURIComponent(listingId)}${query}`, {
        allowNotFound: true,
        requireAuth: false,
      });
    },
    getTrustedCreator(username) {
      return request(`/api/scores/trusted-creator/${encodeURIComponent(username)}`, {
        requireAuth: false,
      });
    },
    submitListingScore(payload) {
      return request("/api/scores", {
        method: "POST",
        body: JSON.stringify(payload),
        requireAuth: false,
      });
    },
    getImageScore(imageHash) {
      return request(`/api/scores/images/${encodeURIComponent(imageHash)}`, {
        allowNotFound: true,
        requireAuth: false,
      });
    },
    submitImageScore(payload) {
      return request("/api/scores/images", {
        method: "POST",
        body: JSON.stringify(payload),
        requireAuth: false,
      });
    },
    evaluateDescription(description, listingDetails = {}) {
      return request("/api/evaluate-description", {
        method: "POST",
        body: JSON.stringify({ description, listingDetails }),
      });
    },
    evaluateReviews(reviewsAndImages) {
      return request("/api/reviews/evaluate", {
        method: "POST",
        body: JSON.stringify({ reviewsAndImages }),
      });
    },
    getUserReviews(platform, listingId) {
      return request(`/api/reports/${encodeURIComponent(platform)}/${encodeURIComponent(listingId)}`);
    },
    submitUserReview(payload) {
      return request("/api/reports", { method: "POST", body: JSON.stringify(payload) });
    },
    runDiagnostics() {
      return request("/api/diagnostics");
    },
  };
}

export const apiClient = createApiClient();
