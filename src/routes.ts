import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { eligible, type Release } from "./domain.js";
import { MinioObjectStorage } from "./storage.js";
export const router = Router();
const releases = new Map<string, Release>();
const assignments = new Map<
  string,
  { id: string; releaseId: string; deviceId: string; status: string }
>();
router.post("/releases", (request, response) => {
  const release = {
    ...z
      .object({
        hardwareModel: z.string(),
        version: z.string(),
        sizeBytes: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        signature: z.object({
          algorithm: z.string(),
          keyId: z.string(),
          value: z.string().min(1),
        }),
        ring: z.enum(["DEVELOPMENT", "INTERNAL", "BETA", "PRODUCTION"]),
        expiresAt: z.string().datetime(),
        objectKey: z.string(),
      })
      .parse(request.body),
    id: randomUUID(),
  };
  releases.set(release.id, release);
  response.status(201).json(release);
});
router.get("/releases", (_request, response) =>
  response.json({ items: [...releases.values()] }),
);
router.post("/releases/:id/eligibility", (request, response) => {
  const release = releases.get(request.params.id);
  response
    .status(release ? 200 : 404)
    .json(
      release ? { eligible: eligible(release, request.body) } : { status: 404 },
    );
});
router.post("/releases/:id/assignments", async (request, response) => {
  const release = releases.get(request.params.id);
  if (!release) return response.status(404).json({ status: 404 });
  const device = z
    .object({
      deviceId: z.string(),
      hardwareModel: z.string(),
      version: z.string(),
      ring: z.enum(["DEVELOPMENT", "INTERNAL", "BETA", "PRODUCTION"]),
    })
    .parse(request.body);
  if (!eligible(release, device))
    return response
      .status(409)
      .json({ title: "Device is not eligible", status: 409 });
  const assignment = {
    id: randomUUID(),
    releaseId: release.id,
    deviceId: device.deviceId,
    status: "ASSIGNED",
  };
  assignments.set(assignment.id, assignment);
  const downloadUrl = await new MinioObjectStorage().temporaryDownloadUrl(
    release.objectKey,
    300,
  );
  return response.status(201).json({
    assignment,
    manifest: release,
    downloadUrl,
    expiresInSeconds: 300,
  });
});
router.get("/devices/:id/assignment", (request, response) => {
  const assignment = [...assignments.values()].find(
    (value) => value.deviceId === request.params.id,
  );
  response.status(assignment ? 200 : 404).json(assignment ?? { status: 404 });
});
router.post("/assignments/:id/status", (request, response) => {
  const assignment = assignments.get(request.params.id);
  if (!assignment) return response.status(404).json({ status: 404 });
  const status = z
    .enum([
      "NOTIFIED",
      "DOWNLOADING",
      "VERIFIED",
      "INSTALLED",
      "FAILED",
      "ROLLED_BACK",
    ])
    .parse(request.body.status);
  assignment.status = status;
  return response.json(assignment);
});
