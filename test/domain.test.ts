import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, eligible, type Release } from "../src/domain.js";

const release: Release = {
  releaseId: "10000000-0000-4000-8000-000000000001",
  hardwareModel: "ESP32-S3-N16R8",
  version: "1.1.0",
  sizeBytes: 100,
  sha256: "a".repeat(64),
  signature: "A".repeat(44),
  signatureAlgorithm: "ECDSA_P256_SHA256",
  objectKey: "firmware.bin",
  publishedAt: "2026-07-23T00:00:00Z",
  createdBy: "release-service",
};

test("eligibility checks model, digest, signature, and semantic downgrade", () => {
  assert.equal(
    eligible(release, {
      deviceId: "AG-000001",
      hardwareModel: release.hardwareModel,
      firmwareVersion: "1.0.0",
    }),
    true,
  );
  assert.equal(
    eligible(release, {
      deviceId: "AG-000001",
      hardwareModel: "OTHER",
      firmwareVersion: "1.0.0",
    }),
    false,
  );
  assert.equal(
    eligible(
      { ...release, version: "0.9.0" },
      {
        deviceId: "AG-000001",
        hardwareModel: release.hardwareModel,
        firmwareVersion: "1.0.0",
      },
    ),
    false,
  );
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
});
