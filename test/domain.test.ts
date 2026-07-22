import test from "node:test";
import assert from "node:assert/strict";
import { eligible, type Release } from "../src/domain.js";
const release: Release = {
  id: "r",
  hardwareModel: "ESP32-S3-N16R8",
  version: "1.1.0",
  sizeBytes: 100,
  sha256: "a".repeat(64),
  signature: {
    algorithm: "ECDSA_P256_SHA256",
    keyId: "development",
    value: "signature",
  },
  ring: "DEVELOPMENT",
  expiresAt: "2030-01-01T00:00:00Z",
  objectKey: "firmware.bin",
};
test("eligible release checks model, expiry, digest, signature, and downgrade", () => {
  assert.equal(
    eligible(
      release,
      {
        hardwareModel: "ESP32-S3-N16R8",
        version: "1.0.0",
        ring: "DEVELOPMENT",
      },
      Date.parse("2029-01-01T00:00:00Z"),
    ),
    true,
  );
  assert.equal(
    eligible(
      release,
      { hardwareModel: "other", version: "1.0.0", ring: "DEVELOPMENT" },
      Date.parse("2029-01-01T00:00:00Z"),
    ),
    false,
  );
  assert.equal(
    eligible(
      { ...release, version: "0.9.0" },
      {
        hardwareModel: release.hardwareModel,
        version: "1.0.0",
        ring: "DEVELOPMENT",
      },
      Date.parse("2029-01-01T00:00:00Z"),
    ),
    false,
  );
});
