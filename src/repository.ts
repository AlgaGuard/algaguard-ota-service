import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  Assignment,
  OtaRepository,
  OtaStatus,
  Release,
  RolloutRing,
  SignatureAlgorithm,
} from "./domain.js";

function release(row: Record<string, unknown>): Release {
  const signature = row.signature as { value?: string; algorithm?: string };
  return {
    releaseId: String(row.id),
    hardwareModel: String(row.hardware_model),
    version: String(row.version),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    signature: String(signature.value),
    signatureAlgorithm: String(signature.algorithm) as SignatureAlgorithm,
    objectKey: String(row.object_key),
    publishedAt: new Date(row.published_at as Date | string).toISOString(),
    createdBy: String(row.created_by),
  };
}

function assignment(row: Record<string, unknown>): Assignment {
  return {
    assignmentId: String(row.id),
    rolloutId: String(row.rollout_id),
    releaseId: String(row.release_id),
    deviceId: String(row.device_id),
    rolloutRing: String(row.rollout_ring) as RolloutRing,
    status: String(row.status),
    assignedAt: new Date(row.assigned_at as Date | string).toISOString(),
    expiresAt: new Date(row.expires_at as Date | string).toISOString(),
    hardwareModel: String(row.hardware_model),
    runningVersion: String(row.running_version),
  };
}

export class PostgresOtaRepository implements OtaRepository {
  constructor(readonly pool: pg.Pool) {}

  async createRelease(input: Omit<Release, "publishedAt">) {
    const result = await this.pool.query(
      `INSERT INTO ota_releases(
        id,hardware_model,version,size_bytes,sha256,signature,object_key,created_by)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT(id) DO NOTHING RETURNING *`,
      [
        input.releaseId,
        input.hardwareModel,
        input.version,
        input.sizeBytes,
        input.sha256,
        JSON.stringify({
          value: input.signature,
          algorithm: input.signatureAlgorithm,
        }),
        input.objectKey,
        input.createdBy,
      ],
    );
    const row =
      (result.rows[0] as Record<string, unknown> | undefined) ??
      ((
        await this.pool.query("SELECT * FROM ota_releases WHERE id=$1", [
          input.releaseId,
        ])
      ).rows[0] as Record<string, unknown> | undefined);
    if (!row) throw new Error("Release was not created or found");
    return { release: release(row), created: Boolean(result.rows[0]) };
  }

  async getRelease(releaseId: string) {
    const result = await this.pool.query(
      "SELECT * FROM ota_releases WHERE id=$1",
      [releaseId],
    );
    return result.rows[0]
      ? release(result.rows[0] as Record<string, unknown>)
      : undefined;
  }

  async listReleases(limit: number) {
    const result = await this.pool.query(
      "SELECT * FROM ota_releases ORDER BY published_at DESC LIMIT $1",
      [Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows.map((row) => release(row as Record<string, unknown>));
  }

  async createRollout(input: {
    releaseId: string;
    ring: RolloutRing;
    createdBy: string;
    devices: Array<{
      deviceId: string;
      hardwareModel: string;
      firmwareVersion: string;
    }>;
    expiresAt: string;
  }) {
    const client = await this.pool.connect();
    const rolloutId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ota_rollouts(id,release_id,rollout_ring,status,created_by)
         VALUES($1,$2,$3,'ACTIVE',$4)`,
        [rolloutId, input.releaseId, input.ring, input.createdBy],
      );
      const assignments: Assignment[] = [];
      for (const device of input.devices) {
        const result = await client.query(
          `INSERT INTO ota_assignments(
            id,release_id,device_id,status,rollout_id,rollout_ring,expires_at,hardware_model,running_version)
           VALUES($1,$2,$3,'ASSIGNED',$4,$5,$6,$7,$8)
           ON CONFLICT(release_id,device_id) DO UPDATE SET
             rollout_id=EXCLUDED.rollout_id,rollout_ring=EXCLUDED.rollout_ring,
             expires_at=EXCLUDED.expires_at,hardware_model=EXCLUDED.hardware_model,
             running_version=EXCLUDED.running_version,status='ASSIGNED',assigned_at=now()
           RETURNING *`,
          [
            randomUUID(),
            input.releaseId,
            device.deviceId,
            rolloutId,
            input.ring,
            input.expiresAt,
            device.hardwareModel,
            device.firmwareVersion,
          ],
        );
        assignments.push(assignment(result.rows[0] as Record<string, unknown>));
      }
      await client.query("COMMIT");
      return { rolloutId, status: "ACTIVE" as const, assignments };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async assignmentFor(deviceId: string) {
    const result = await this.pool.query(
      `SELECT * FROM ota_assignments
       WHERE device_id=$1 AND expires_at > now()
       ORDER BY assigned_at DESC LIMIT 1`,
      [deviceId],
    );
    return result.rows[0]
      ? assignment(result.rows[0] as Record<string, unknown>)
      : undefined;
  }

  async recordStatus(status: OtaStatus) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        "SELECT * FROM ota_assignments WHERE id=$1 FOR UPDATE",
        [status.assignmentId],
      );
      const row = found.rows[0] as Record<string, unknown> | undefined;
      if (
        !row ||
        String(row.device_id) !== status.deviceId ||
        String(row.release_id) !== status.releaseId ||
        new Date(row.expires_at as Date | string).getTime() <= Date.now()
      ) {
        await client.query("ROLLBACK");
        return undefined;
      }
      const inserted = await client.query(
        `INSERT INTO ota_status_history(
          message_id,assignment_id,device_id,release_id,status,progress_percent,
          downloaded_bytes,reported_at,running_version,error)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT(message_id) DO NOTHING RETURNING message_id`,
        [
          status.messageId,
          status.assignmentId,
          status.deviceId,
          status.releaseId,
          status.status,
          status.progressPercent,
          status.downloadedBytes,
          status.reportedAt,
          status.runningVersion,
          JSON.stringify(status.error ?? null),
        ],
      );
      if (inserted.rowCount)
        await client.query(
          "UPDATE ota_assignments SET status=$2,running_version=$3 WHERE id=$1",
          [status.assignmentId, status.status, status.runningVersion],
        );
      await client.query("COMMIT");
      return assignment({
        ...row,
        status: inserted.rowCount ? status.status : row.status,
        running_version: status.runningVersion,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async health() {
    await this.pool.query("SELECT 1");
  }
  async close() {
    await this.pool.end();
  }
}
