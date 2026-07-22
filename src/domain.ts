export type RolloutRing = "DEVELOPMENT" | "INTERNAL" | "BETA" | "PRODUCTION";
export interface Release {
  id: string;
  hardwareModel: string;
  version: string;
  sizeBytes: number;
  sha256: string;
  signature: { algorithm: string; keyId: string; value: string };
  ring: RolloutRing;
  expiresAt: string;
  objectKey: string;
}
export interface ObjectStorage {
  temporaryDownloadUrl(key: string, expiresSeconds: number): Promise<string>;
}
export function eligible(
  release: Release,
  device: { hardwareModel: string; version: string; ring: RolloutRing },
  now = Date.now(),
  recoveryDowngrade = false,
) {
  if (
    release.hardwareModel !== device.hardwareModel ||
    Date.parse(release.expiresAt) <= now
  )
    return false;
  if (!/^[0-9a-f]{64}$/.test(release.sha256) || !release.signature.value)
    return false;
  if (
    !recoveryDowngrade &&
    release.version.localeCompare(device.version, undefined, {
      numeric: true,
    }) < 0
  )
    return false;
  return (
    ["DEVELOPMENT", "INTERNAL", "BETA", "PRODUCTION"].indexOf(device.ring) <=
    ["DEVELOPMENT", "INTERNAL", "BETA", "PRODUCTION"].indexOf(release.ring)
  );
}
