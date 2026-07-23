import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresOtaRepository } from "../src/repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
test(
  "release, rollout, assignment, and idempotent status survive repository restarts",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const cleanup = new pg.Pool({ connectionString: databaseUrl });
    await cleanup.query(
      "TRUNCATE ota_status_history,ota_assignments,ota_rollouts,ota_releases",
    );
    await cleanup.end();
    const releaseId = "10000000-0000-4000-8000-000000000001";
    const first = new PostgresOtaRepository(
      new pg.Pool({ connectionString: databaseUrl }),
    );
    await first.createRelease({
      releaseId,
      hardwareModel: "ESP32-S3-N16R8",
      version: "1.1.0",
      sizeBytes: 100,
      sha256: "a".repeat(64),
      signature: "A".repeat(44),
      signatureAlgorithm: "ECDSA_P256_SHA256",
      objectKey: "firmware/release.bin",
      createdBy: "release-pipeline",
    });
    await first.close();

    const restarted = new PostgresOtaRepository(
      new pg.Pool({ connectionString: databaseUrl }),
    );
    assert.equal((await restarted.getRelease(releaseId))?.version, "1.1.0");
    const rollout = await restarted.createRollout({
      releaseId,
      ring: "DEVELOPMENT",
      createdBy: "admin",
      expiresAt: "2099-07-23T00:15:00Z",
      devices: [
        {
          deviceId: "AG-000001",
          hardwareModel: "ESP32-S3-N16R8",
          firmwareVersion: "1.0.0",
        },
      ],
    });
    const assignment = rollout.assignments[0]!;
    await restarted.close();

    const recovered = new PostgresOtaRepository(
      new pg.Pool({ connectionString: databaseUrl }),
    );
    assert.equal(
      (await recovered.assignmentFor("AG-000001"))?.assignmentId,
      assignment.assignmentId,
    );
    const status = {
      messageId: "30000000-0000-4000-8000-000000000001",
      assignmentId: assignment.assignmentId,
      deviceId: "AG-000001",
      releaseId,
      status: "VERIFIED" as const,
      progressPercent: 70,
      downloadedBytes: 100,
      reportedAt: "2026-07-23T00:02:00Z",
      runningVersion: "1.0.0",
    };
    assert.equal((await recovered.recordStatus(status))?.status, "VERIFIED");
    assert.equal((await recovered.recordStatus(status))?.status, "VERIFIED");
    const count = await recovered.pool.query(
      "SELECT count(*)::int AS count FROM ota_status_history",
    );
    assert.equal(count.rows[0]?.count, 1);
    assert.equal(
      await recovered.recordStatus({
        ...status,
        messageId: "30000000-0000-4000-8000-000000000002",
        deviceId: "AG-000002",
      }),
      undefined,
    );
    await recovered.close();
  },
);
