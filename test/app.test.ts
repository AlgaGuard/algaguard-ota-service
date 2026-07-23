import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { buildApp } from "../src/app.js";
import type { Authenticator } from "../src/auth.js";
import type { DeviceProvider, OtaAuthorizer } from "../src/services.js";
import { FakeObjectStorage, MemoryOtaRepository } from "./fakes.js";

const authenticate: Authenticator = async (authorization) => {
  if (authorization === "Bearer release")
    return {
      subjectId: "release-pipeline",
      clientId: "algaguard-firmware-release",
      service: true,
    };
  if (authorization === "Bearer device")
    return { subjectId: "AG-000001", service: false };
  return {
    subjectId: authorization === "Bearer denied" ? "denied" : "admin",
    service: false,
  };
};
const authorize: OtaAuthorizer = async (subjectId) =>
  subjectId === "denied"
    ? { allowed: false }
    : { allowed: true, organizationId: "20000000-0000-4000-8000-000000000001" };
const deviceProvider: DeviceProvider = async (deviceId) => ({
  deviceId,
  hardwareModel: "ESP32-S3-N16R8",
  firmwareVersion: "1.0.0",
});
function fixture() {
  const repository = new MemoryOtaRepository();
  const storage = new FakeObjectStorage();
  return {
    repository,
    storage,
    app: buildApp(
      repository,
      storage,
      authenticate,
      authorize,
      deviceProvider,
      undefined,
      {
        bodyLimitBytes: 256 * 1_024,
        assignmentTtlSeconds: 60,
        downloadUrlTtlSeconds: 30,
      },
    ),
  };
}
const release = {
  releaseId: "10000000-0000-4000-8000-000000000001",
  version: "1.1.0",
  hardwareModel: "ESP32-S3-N16R8",
  objectKey: "firmware/release.bin",
  sizeBytes: 100,
  sha256: "a".repeat(64),
  signature: "A".repeat(44),
  signatureAlgorithm: "ECDSA_P256_SHA256",
};

test("liveness, readiness, and correlation middleware are available", async () => {
  const response = await request(fixture().app)
    .get("/health/live")
    .set("x-correlation-id", "test-correlation");
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-correlation-id"], "test-correlation");
  assert.equal((await request(fixture().app).get("/health/ready")).status, 200);
});

test("release registration requires the release client and verified immutable object", async () => {
  const value = fixture();
  assert.equal(
    (
      await request(value.app)
        .post("/v1/firmware/releases")
        .set("authorization", "Bearer admin")
        .send(release)
    ).status,
    403,
  );
  value.storage.valid = false;
  assert.equal(
    (
      await request(value.app)
        .post("/v1/firmware/releases")
        .set("authorization", "Bearer release")
        .send(release)
    ).status,
    422,
  );
  value.storage.valid = true;
  assert.equal(
    (
      await request(value.app)
        .post("/v1/firmware/releases")
        .set("authorization", "Bearer release")
        .send(release)
    ).status,
    201,
  );
  assert.equal(
    (
      await request(value.app)
        .post("/v1/firmware/releases")
        .set("authorization", "Bearer release")
        .send({ ...release, version: "2.0.0" })
    ).status,
    409,
  );
});

test("authorized eligible rollout creates a short-lived assignment", async () => {
  const value = fixture();
  await request(value.app)
    .post("/v1/firmware/releases")
    .set("authorization", "Bearer release")
    .send(release);
  assert.equal(
    (
      await request(value.app)
        .post("/v1/ota/rollouts")
        .set("authorization", "Bearer denied")
        .send({
          releaseId: release.releaseId,
          rolloutRing: "DEVELOPMENT",
          deviceIds: ["AG-000001"],
        })
    ).status,
    403,
  );
  const rollout = await request(value.app)
    .post("/v1/ota/rollouts")
    .set("authorization", "Bearer admin")
    .send({
      releaseId: release.releaseId,
      rolloutRing: "DEVELOPMENT",
      deviceIds: ["AG-000001"],
    });
  assert.equal(rollout.status, 201);
  const assignment = await request(value.app)
    .get("/v1/devices/AG-000001/assignment")
    .set("authorization", "Bearer device");
  assert.equal(assignment.status, 200);
  assert.match(assignment.body.downloadUrl, /^https:\/\//);
  assert.equal(assignment.body.expiresInSeconds, 30);
  assert.match(assignment.body.downloadUrl, /expires=30$/);
});
