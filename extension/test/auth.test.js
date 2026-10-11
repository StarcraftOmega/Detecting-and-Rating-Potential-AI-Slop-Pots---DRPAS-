import assert from "node:assert/strict";
import test from "node:test";
import { SUPABASE_URL } from "../src/background/build-config.js";
import { checkSignInSetup } from "../src/background/auth.js";

async function verifyBundledConfigFallback(generatedConfig) {
  const requestedUrls = [];
  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
    },
  };
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).endsWith("/src/background/build-config.json")) {
      return generatedConfig === null
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify(generatedConfig), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  await checkSignInSetup("https://api.example.com");
  assert.ok(requestedUrls.includes(`${SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/settings`));
}

test("uses bundled public Supabase config when generated config is missing", async () => {
  await verifyBundledConfigFallback(null);
});

test("uses bundled public Supabase config when generated config is empty", async () => {
  await verifyBundledConfigFallback({
    SUPABASE_URL: "",
    SUPABASE_PUBLISHABLE_KEY: "",
  });
});