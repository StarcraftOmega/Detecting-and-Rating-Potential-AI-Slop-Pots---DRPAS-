import {
  SUPABASE_URL as defaultSupabaseUrl,
  SUPABASE_PUBLISHABLE_KEY as defaultPublishableKey,
} from "./build-config.js";

const SESSION_KEY = "serverSession";
const AUTH_TIMEOUT_MS = 12000;

async function authConfig() {
  const response = await fetch(chrome.runtime.getURL("src/background/build-config.json"));
  let builtConfig = {};
  if (response.ok) {
    builtConfig = await response.json();
  } else if (response.status !== 404) {
    throw new Error(`Generated Supabase config request failed with HTTP ${response.status}.`);
  }
  const supabaseUrl = typeof builtConfig.SUPABASE_URL === "string" && builtConfig.SUPABASE_URL.trim()
    ? builtConfig.SUPABASE_URL : defaultSupabaseUrl;
  const publishableKey = typeof builtConfig.SUPABASE_PUBLISHABLE_KEY === "string" &&
    builtConfig.SUPABASE_PUBLISHABLE_KEY.trim()
    ? builtConfig.SUPABASE_PUBLISHABLE_KEY : defaultPublishableKey;
  if (typeof supabaseUrl !== "string" || !/^https:\/\/[\w.-]+\.supabase\.co\/?$/i.test(supabaseUrl)) {
    throw new Error("Supabase URL is missing from the bundled public config.");
  }
  if (typeof publishableKey !== "string" || !publishableKey.trim()) {
    throw new Error("Supabase publishable key is missing from the bundled public config.");
  }
  return { supabaseUrl: supabaseUrl.replace(/\/+$/, ""), publishableKey };
}

async function fetchAuth(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Supabase request timed out after 12 seconds. Check connectivity and extension host permissions.");
    }
    if (error instanceof TypeError) {
      throw new Error("Could not reach Supabase. Check the project URL, extension host permissions, and network connection.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkSignInSetup(serverBaseUrl) {
  const { supabaseUrl, publishableKey } = await authConfig();
  if (typeof serverBaseUrl !== "string" || !/^https:\/\/[^/]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(serverBaseUrl)) {
    throw new Error("API server URL is invalid. Use an HTTPS URL or localhost.");
  }

  let apiResponse;
  try {
    apiResponse = await fetchAuth(`${serverBaseUrl.replace(/\/+$/, "")}/api/health`, {
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new Error(`API server check failed: ${error.message}`);
  }
  if (!apiResponse.ok) {
    throw new Error(`API server returned HTTP ${apiResponse.status} from /api/health.`);
  }

  let supabaseResponse;
  try {
    supabaseResponse = await fetchAuth(`${supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: publishableKey, Accept: "application/json" },
    });
  } catch (error) {
    throw new Error(`Supabase check failed: ${error.message}`);
  }
  if (!supabaseResponse.ok) {
    throw new Error(`Supabase rejected the publishable key or project URL (HTTP ${supabaseResponse.status}).`);
  }
  return { ok: true };
}

export async function signInWithPassword({ email, password }) {
  if (typeof email !== "string" || !email.trim() ||
      typeof password !== "string" || !password) {
    throw new Error("Email and password are required.");
  }
  const { supabaseUrl, publishableKey } = await authConfig();

  const response = await fetchAuth(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: publishableKey,
    },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = typeof body.msg === "string" ? body.msg
      : typeof body.error_description === "string" ? body.error_description
        : typeof body.message === "string" ? body.message : "Sign-in failed.";
    throw new Error(`Supabase sign-in failed (HTTP ${response.status}): ${reason}`);
  }
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("Supabase did not return an access token.");
  }
  const expiresAt = Number.isFinite(Number(body.expires_at))
    ? new Date(Number(body.expires_at) * 1000).toISOString()
    : Number.isFinite(Number(body.expires_in))
      ? new Date(Date.now() + Number(body.expires_in) * 1000).toISOString()
      : null;
  await setSession({
    accessToken: body.access_token,
    expiresAt,
    user: body.user && typeof body.user === "object"
      ? { id: body.user.id, email: body.user.email } : null,
  });
  return { user: body.user && typeof body.user === "object"
    ? { id: body.user.id, email: body.user.email } : null };
}

export async function signUpWithPassword({ email, password }) {
  if (typeof email !== "string" || !email.trim() ||
      typeof password !== "string" || !password) {
    throw new Error("Email and password are required.");
  }
  const { supabaseUrl, publishableKey } = await authConfig();
  const response = await fetchAuth(`${supabaseUrl}/auth/v1/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: publishableKey,
    },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = typeof body.msg === "string" ? body.msg
      : typeof body.error_description === "string" ? body.error_description
        : typeof body.message === "string" ? body.message : "Sign-up failed.";
    throw new Error(`Supabase sign-up failed (HTTP ${response.status}): ${reason}`);
  }
  if (typeof body.access_token === "string" && body.access_token) {
    await setSession({
      accessToken: body.access_token,
      expiresAt: Number.isFinite(Number(body.expires_at))
        ? new Date(Number(body.expires_at) * 1000).toISOString()
        : null,
      user: body.user && typeof body.user === "object"
        ? { id: body.user.id, email: body.user.email } : null,
    });
  }
  return {
    user: body.user && typeof body.user === "object"
      ? { id: body.user.id, email: body.user.email } : null,
    requiresEmailConfirmation: !body.access_token,
  };
}

function chromeStorage() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    throw new Error("extension storage is unavailable");
  }
  return chrome.storage.local;
}

export async function getSession() {
  const stored = await chromeStorage().get(SESSION_KEY);
  const session = stored[SESSION_KEY];
  if (!session || typeof session !== "object" ||
      typeof session.accessToken !== "string" || !session.accessToken) {
    return null;
  }
  return {
    accessToken: session.accessToken,
    expiresAt: typeof session.expiresAt === "string" ? session.expiresAt : null,
    user: session.user && typeof session.user === "object" ? session.user : null,
  };
}

export async function getAccessToken() {
  const session = await getSession();
  if (!session) return null;
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    await clearSession();
    return null;
  }
  return session.accessToken;
}

export async function setSession(session) {
  if (!session || typeof session.accessToken !== "string" || !session.accessToken) {
    throw new Error("an access token is required");
  }
  await chromeStorage().set({
    [SESSION_KEY]: {
      accessToken: session.accessToken,
      expiresAt: typeof session.expiresAt === "string" ? session.expiresAt : null,
      user: session.user && typeof session.user === "object" ? session.user : null,
    },
  });
}

export async function clearSession() {
  await chromeStorage().remove(SESSION_KEY);
  await chromeStorage().remove("serverListingCache");
}