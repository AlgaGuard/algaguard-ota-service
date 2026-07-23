import assert from "node:assert/strict";
import test from "node:test";
import type { Assignment, Release } from "../src/domain.js";
import { otaNotification } from "../src/transport.js";

const assignment: Assignment = {
  assignmentId: "10000000-0000-4000-8000-000000000001",
  rolloutId: "20000000-0000-4000-8000-000000000001",
  releaseId: "30000000-0000-4000-8000-000000000001",
  deviceId: "AG-000001",
  rolloutRing: "DEVELOPMENT",
  status: "NOTIFIED",
  assignedAt: "2026-07-24T00:00:00Z",
  expiresAt: "2026-07-24T00:15:00Z",
  hardwareModel: "ESP32-S3-DEVKITC-1-N16R8",
  runningVersion: "1.0.0",
};
const release: Release = {
  releaseId: assignment.releaseId,
  hardwareModel: assignment.hardwareModel,
  version: "1.0.1",
  sizeBytes: 1024,
  sha256: "a".repeat(64),
  signature: "A".repeat(64),
  signatureAlgorithm: "ED25519",
  objectKey: "e2e/firmware.bin",
  publishedAt: "2026-07-24T00:00:00Z",
  createdBy: "release-service",
};

test("OTA notification is identity-bound and contains public release data only", () => {
  const notification = otaNotification(
    assignment,
    release,
    "https://downloads.example/temporary",
  );
  assert.equal(notification.deviceId, "AG-000001");
  assert.equal(notification.payload.releaseId, release.releaseId);
  assert.equal(notification.payload.expiresAt, assignment.expiresAt);
  assert.equal(notification.payload.mandatory, false);
  assert.doesNotMatch(JSON.stringify(notification), /private.?key|password/i);
});
