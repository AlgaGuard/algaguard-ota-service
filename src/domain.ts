export type RolloutRing = "DEVELOPMENT" | "INTERNAL" | "BETA" | "PRODUCTION";
export type SignatureAlgorithm = "ED25519" | "ECDSA_P256_SHA256";
export interface Release {
  releaseId: string;
  hardwareModel: string;
  version: string;
  sizeBytes: number;
  sha256: string;
  signature: string;
  signatureAlgorithm: SignatureAlgorithm;
  objectKey: string;
  publishedAt: string;
  createdBy: string;
}
export interface DeviceCandidate {
  deviceId: string;
  hardwareModel: string;
  firmwareVersion: string;
}
export interface Assignment {
  assignmentId: string;
  rolloutId: string;
  releaseId: string;
  deviceId: string;
  rolloutRing: RolloutRing;
  status: string;
  assignedAt: string;
  expiresAt: string;
  hardwareModel: string;
  runningVersion: string;
}
export interface OtaStatus {
  messageId: string;
  assignmentId: string;
  deviceId: string;
  releaseId: string;
  status:
    | "NOTIFIED"
    | "DOWNLOADING"
    | "DOWNLOADED"
    | "VERIFIED"
    | "INSTALLING"
    | "PENDING_BOOT_VALIDATION"
    | "SUCCEEDED"
    | "FAILED"
    | "ROLLED_BACK"
    | "REJECTED";
  progressPercent: number;
  downloadedBytes: number;
  reportedAt: string;
  runningVersion: string;
  error?: { code: string; message: string; retryable: boolean; path?: string };
}
export interface ObjectStorage {
  verifyObject(
    release: Omit<Release, "publishedAt" | "createdBy">,
  ): Promise<boolean>;
  temporaryDownloadUrl(key: string, expiresSeconds: number): Promise<string>;
  health(): Promise<void>;
}
export interface OtaRepository {
  createRelease(
    input: Omit<Release, "publishedAt">,
  ): Promise<{ release: Release; created: boolean }>;
  getRelease(releaseId: string): Promise<Release | undefined>;
  listReleases(limit: number): Promise<Release[]>;
  createRollout(input: {
    releaseId: string;
    ring: RolloutRing;
    createdBy: string;
    devices: DeviceCandidate[];
    expiresAt: string;
  }): Promise<{
    rolloutId: string;
    status: "ACTIVE";
    assignments: Assignment[];
  }>;
  assignmentFor(deviceId: string): Promise<Assignment | undefined>;
  recordStatus(status: OtaStatus): Promise<Assignment | undefined>;
  health(): Promise<void>;
  close(): Promise<void>;
}

function versionParts(version: string) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(
      version,
    );
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

export function compareVersions(left: string, right: string) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) throw new Error("Versions must use semantic versioning");
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

export function eligible(
  release: Release,
  device: DeviceCandidate,
  recoveryDowngrade = false,
) {
  if (release.hardwareModel !== device.hardwareModel) return false;
  if (
    !/^[0-9a-f]{64}$/.test(release.sha256) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(release.signature)
  )
    return false;
  return (
    recoveryDowngrade ||
    compareVersions(release.version, device.firmwareVersion) >= 0
  );
}
