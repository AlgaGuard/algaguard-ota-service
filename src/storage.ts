import { Client } from "minio";
import type { ObjectStorage } from "./domain.js";

export class MinioObjectStorage implements ObjectStorage {
  private readonly client: Client;
  private readonly bucket: string;
  constructor(endpoint = process.env.MINIO_ENDPOINT ?? "http://minio:9000") {
    const url = new URL(endpoint);
    this.bucket = process.env.MINIO_BUCKET ?? "algaguard-ota-development";
    this.client = new Client({
      endPoint: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      useSSL: url.protocol === "https:",
      accessKey: process.env.MINIO_ACCESS_KEY ?? "",
      secretKey: process.env.MINIO_SECRET_KEY ?? "",
    });
  }
  temporaryDownloadUrl(key: string, expiresSeconds: number) {
    return this.client.presignedGetObject(this.bucket, key, expiresSeconds);
  }
}
