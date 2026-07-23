import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Client } from "minio";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MinioObjectStorage } from "../src/storage.js";

const endpoint = process.env.TEST_MINIO_ENDPOINT;
test(
  "MinIO verifies the binary digest/signature and creates a temporary URL",
  { skip: endpoint ? false : "TEST_MINIO_ENDPOINT is not configured" },
  async () => {
    const accessKey = process.env.TEST_MINIO_ACCESS_KEY ?? "algaguard-test";
    const secretKey =
      process.env.TEST_MINIO_SECRET_KEY ?? "integration-only-secret";
    const bucket = "algaguard-ota-integration";
    const objectKey = "firmware/integration.bin";
    const url = new URL(endpoint!);
    const client = new Client({
      endPoint: url.hostname,
      port: Number(url.port),
      useSSL: url.protocol === "https:",
      accessKey,
      secretKey,
    });
    if (!(await client.bucketExists(bucket))) await client.makeBucket(bucket);
    const artifact = Buffer.from(
      "deterministic AlgaGuard development firmware artifact\n",
    );
    await client.putObject(bucket, objectKey, artifact);
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const signature = sign("sha256", artifact, privateKey).toString("base64");
    const keyDirectory = mkdtempSync(path.join(tmpdir(), "algaguard-ota-key-"));
    const publicKeyPath = path.join(keyDirectory, "signing-public.pem");
    writeFileSync(
      publicKeyPath,
      publicKey.export({ type: "spki", format: "pem" }),
    );
    const storage = new MinioObjectStorage({
      MINIO_ENDPOINT: endpoint,
      MINIO_BUCKET: bucket,
      MINIO_ACCESS_KEY: accessKey,
      MINIO_SECRET_KEY: secretKey,
      OTA_SIGNING_PUBLIC_KEY_PATH: publicKeyPath,
    });
    const release = {
      releaseId: "10000000-0000-4000-8000-000000000001",
      hardwareModel: "ESP32-S3-N16R8",
      version: "1.1.0",
      sizeBytes: artifact.length,
      sha256: createHash("sha256").update(artifact).digest("hex"),
      signature,
      signatureAlgorithm: "ECDSA_P256_SHA256" as const,
      objectKey,
    };
    assert.equal(await storage.verifyObject(release), true);
    assert.equal(
      await storage.verifyObject({ ...release, sha256: "0".repeat(64) }),
      false,
    );
    const downloadUrl = await storage.temporaryDownloadUrl(objectKey, 60);
    assert.equal(new URL(downloadUrl).pathname.includes(objectKey), true);
    await client.removeObject(bucket, objectKey);
    await client.removeBucket(bucket);
    rmSync(keyDirectory, { recursive: true, force: true });
  },
);
