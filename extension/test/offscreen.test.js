import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/background/offscreen.js", import.meta.url), "utf8");
const context = {
  Blob,
  Uint8Array,
  atob,
  chrome: {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener() {} },
    },
  },
  fetch: async () => ({ ok: true, blob: async () => new Blob(["image"]) }),
};
vm.runInNewContext(`${source}\nglobalThis.__getBlob = getBlob;`, context);

test("keeps the blob reuse helper at module scope", () => {
  assert.match(source, /async function getCachedBlob\(imageUrl, imageData\)/);
  assert.match(source, /return imageHash\(await getCachedBlob\(imageUrl, imageData\)\)/);
});

test("decodes image data URLs without fetch so offscreen CSP connect-src allows inference", async () => {
  const blob = await context.__getBlob("", "data:image/jpeg;base64,aW1hZ2U=");

  assert.equal(blob.type, "image/jpeg");
  assert.equal(await blob.text(), "image");
});

test("fetches image URLs with the original force-cache behavior", async () => {
  let request;
  context.fetch = async (...args) => {
    request = args;
    return { ok: true, blob: async () => new Blob(["image"]) };
  };

  await context.__getBlob("https://i.etsystatic.com/image.jpg", "");

  assert.equal(request[0], "https://i.etsystatic.com/image.jpg");
  assert.equal(request[1].credentials, "omit");
  assert.equal(request[1].cache, "force-cache");
});
