import { randomUUID } from "node:crypto";
import type {
  Assignment,
  ObjectStorage,
  OtaRepository,
  OtaStatus,
  Release,
  RolloutRing,
} from "../src/domain.js";

export class MemoryOtaRepository implements OtaRepository {
  releases = new Map<string, Release>();
  assignments = new Map<string, Assignment>();
  statusIds = new Set<string>();
  async createRelease(input: Omit<Release, "publishedAt">) {
    const prior = this.releases.get(input.releaseId);
    if (prior) return { release: structuredClone(prior), created: false };
    const release = {
      ...structuredClone(input),
      publishedAt: new Date().toISOString(),
    };
    this.releases.set(release.releaseId, release);
    return { release: structuredClone(release), created: true };
  }
  async getRelease(id: string) {
    return structuredClone(this.releases.get(id));
  }
  async listReleases(limit: number) {
    return [...this.releases.values()]
      .slice(0, limit)
      .map((value) => structuredClone(value));
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
    const rolloutId = randomUUID();
    const assignments = input.devices.map((device) => {
      const value: Assignment = {
        assignmentId: randomUUID(),
        rolloutId,
        releaseId: input.releaseId,
        deviceId: device.deviceId,
        rolloutRing: input.ring,
        status: "ASSIGNED",
        assignedAt: new Date().toISOString(),
        expiresAt: input.expiresAt,
        hardwareModel: device.hardwareModel,
        runningVersion: device.firmwareVersion,
      };
      this.assignments.set(device.deviceId, value);
      return structuredClone(value);
    });
    return { rolloutId, status: "ACTIVE" as const, assignments };
  }
  async assignmentFor(deviceId: string) {
    return structuredClone(this.assignments.get(deviceId));
  }
  async recordStatus(status: OtaStatus) {
    const assignment = this.assignments.get(status.deviceId);
    if (
      !assignment ||
      assignment.assignmentId !== status.assignmentId ||
      assignment.releaseId !== status.releaseId
    )
      return undefined;
    if (!this.statusIds.has(status.messageId)) {
      this.statusIds.add(status.messageId);
      assignment.status = status.status;
      assignment.runningVersion = status.runningVersion;
    }
    return structuredClone(assignment);
  }
  async health() {}
  async close() {}
}

export class FakeObjectStorage implements ObjectStorage {
  valid = true;
  async verifyObject() {
    return this.valid;
  }
  async temporaryDownloadUrl(key: string, expiresSeconds: number) {
    return `https://objects.example/${key}?expires=${expiresSeconds}`;
  }
  async health() {}
}
