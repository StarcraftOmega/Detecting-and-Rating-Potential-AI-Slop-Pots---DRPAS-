import assert from "node:assert/strict";
import test from "node:test";
import { normalizeServerScore } from "../src/background/listing-cache.js";

test("missing server description scores stay null instead of becoming zero", () => {
  const normalized = normalizeServerScore({
    score: {
      aggregate_score: 0.4,
      description_score: null,
      description_rationale: null,
      calculated_at: new Date().toISOString(),
      images: [],
    },
  });

  assert.equal(normalized.descriptionScore, null);
  assert.equal(normalized.descriptionRationale, "");
});

test("server description scores are preserved when valid", () => {
  const normalized = normalizeServerScore({
    score: {
      aggregate_score: 0.4,
      description_score: 0.72,
      description_rationale: "Detailed rationale",
      calculated_at: new Date().toISOString(),
      images: [],
    },
  });

  test("server scores preserve the stored seller username", () => {
    const normalized = normalizeServerScore({
      score: {
        Username: "SoftpawVintage",
        trusted_creator_score: 1,
        aggregate_score: 0.25,
        calculated_at: new Date().toISOString(),
        images: [],
      },
    });
    assert.equal(normalized.username, "SoftpawVintage");
    assert.equal(normalized.trustedCreatorScore, 1);
  });

  assert.equal(normalized.descriptionScore, 0.72);
  assert.equal(normalized.descriptionRationale, "Detailed rationale");
});

test("server image hashes are normalized for result reuse", () => {
  const normalized = normalizeServerScore({
    score: {
      Username: "SoftpawVintage",
      aggregate_score: 0.4,
      calculated_at: new Date().toISOString(),
      images: [{
        image_hash: "sha256-image-id",
        ai_score: 0.82,
        model_version: "w5810",
      }],
    },
  });

  assert.equal(normalized.username, "SoftpawVintage");
  assert.deepEqual(normalized.images, [{
    imageId: "sha256-image-id",
    score: 0.82,
    modelVersion: "w5810",
    analyzedAt: normalized.calculatedAt,
  }]);
});