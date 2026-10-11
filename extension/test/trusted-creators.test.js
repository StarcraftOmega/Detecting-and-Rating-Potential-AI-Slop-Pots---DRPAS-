import assert from "node:assert/strict";
import test from "node:test";
import { lookupTrustedCreator } from "../src/background/trusted-creators.js";

test("normalizes a listed trusted creator", () => {
  assert.deepEqual(
    lookupTrustedCreator({
      serverChecked: true,
      username: "SoftpawVintage",
      trustedCreatorScore: 1,
    }, "SoftpawVintage"),
    { status: "trusted", creator: "SoftpawVintage" },
  );
});

test("normalizes a server-confirmed unknown creator", () => {
  assert.deepEqual(
    lookupTrustedCreator({
      serverChecked: true,
      username: "UnknownShop",
      trustedCreatorScore: 0,
    }, "UnknownShop"),
    { status: "unknown", creator: "UnknownShop" },
  );
});

test("treats a missing stored flag as unknown after a server check", () => {
  assert.deepEqual(
    lookupTrustedCreator({ serverChecked: true, username: "UnknownShop" }, "UnknownShop"),
    { status: "unknown", creator: "UnknownShop" },
  );
});

test("requires the stored username to match the current seller", () => {
  assert.deepEqual(
    lookupTrustedCreator({
      serverChecked: true,
      username: "DifferentShop",
      trustedCreatorScore: 1,
    }, "CurrentShop"),
    { status: "unknown", creator: "CurrentShop" },
  );
});

test("matches database-shaped score fields", () => {
  assert.deepEqual(
    lookupTrustedCreator({
      serverChecked: true,
      username: "SoftpawVintage",
      trustedCreatorScore: 1,
    }, "softpawvintage"),
    { status: "trusted", creator: "softpawvintage" },
  );
});

test("accepts the seller lookup result when the stored flag is numeric", () => {
  assert.deepEqual(
    lookupTrustedCreator({
      serverChecked: true,
      username: "SydGrahamPatterns",
      trustedCreatorScore: 1,
    }, "SydGrahamPatterns"),
    { status: "trusted", creator: "SydGrahamPatterns" },
  );
});

test("does not call an unchecked seller unknown", () => {
  const assessment = lookupTrustedCreator({ serverChecked: false }, "SoftpawVintage");
  assert.deepEqual(assessment, {
    status: "unavailable",
    message: "Trusted creator status was not checked.",
  });
});