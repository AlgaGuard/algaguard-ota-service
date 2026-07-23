import {
  createHash,
  createVerify,
  verify as verifySignature,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "minio";
import type { ObjectStorage, Release } from "./domain.js";

export class MinioObjectStorage implements ObjectStorage {
  private readonly client: Client;
  private readonly bucket: string;
  private readonly publicKey: string;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const endpoint = environment.MINIO_ENDPOINT ?? "http://minio:9000";
    const url = new URL(endpoint);
    const accessKey = environment.MINIO_ACCESS_KEY;
    const secretKey = environment.MINIO_SECRET_KEY;
    const publicKey =
      environment.OTA_SIGNING_PUBLIC_KEY_PEM ??
      (environment.OTA_SIGNING_PUBLIC_KEY_PATH
        ? readFileSync(environment.OTA_SIGNING_PUBLIC_KEY_PATH, "utf8")
        : undefined);
    if (!accessKey || !secretKey || !publicKey)
      throw new Error(
        "MINIO credentials and an OTA signing public key are required",
      );
    this.bucket = environment.MINIO_BUCKET ?? "algaguard-ota-development";
    this.publicKey = publicKey.replace(/\\n/g, "\n");
    this.client = new Client({
      endPoint: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      useSSL: url.protocol === "https:",
      accessKey,
      secretKey,
    });
  }

  async verifyObject(release: Omit<Release, "publishedAt" | "createdBy">) {
    const stream = await this.client.getObject(this.bucket, release.objectKey);
    const hash = createHash("sha256");
    const verifier =
      release.signatureAlgorithm === "ECDSA_P256_SHA256"
        ? createVerify("SHA256")
        : undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > release.sizeBytes) {
        stream.destroy();
        return false;
      }
      hash.update(bytes);
      verifier?.update(bytes);
      if (!verifier) {
        if (size > 64 * 1024 * 1024) return false;
        chunks.push(bytes);
      }
    }
    if (size !== release.sizeBytes || hash.digest("hex") !== release.sha256)
      return false;
    const signature = Buffer.from(release.signature, "base64");
    return verifier
      ? verifier.verify(this.publicKey, signature)
      : verifySignature(null, Buffer.concat(chunks), this.publicKey, signature);
  }

  temporaryDownloadUrl(key: string, expiresSeconds: number) {
    return this.client.presignedGetObject(this.bucket, key, expiresSeconds);
  }

  async health() {
    if (!(await this.client.bucketExists(this.bucket)))
      throw new Error("OTA bucket is unavailable");
  }
}
