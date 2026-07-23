import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { createAuthenticator, HttpError, type Authenticator } from "./auth.js";
import {
  eligible,
  type ObjectStorage,
  type OtaRepository,
  type Release,
} from "./domain.js";
import {
  createDeviceProvider,
  createOtaAuthorizer,
  type DeviceProvider,
  type OtaAuthorizer,
} from "./services.js";

const releaseInput = z
  .object({
    releaseId: z.string().uuid(),
    version: z
      .string()
      .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/)
      .max(64),
    hardwareModel: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{1,63}$/),
    objectKey: z.string().min(1).max(512),
    sizeBytes: z.number().int().min(1).max(2_147_483_648),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .min(40)
      .max(512),
    signatureAlgorithm: z.enum(["ED25519", "ECDSA_P256_SHA256"]),
  })
  .strict();
const rolloutInput = z
  .object({
    releaseId: z.string().uuid(),
    rolloutRing: z.enum(["DEVELOPMENT", "INTERNAL", "BETA", "PRODUCTION"]),
    deviceIds: z
      .array(z.string().regex(/^AG-[0-9]{6}$/))
      .min(1)
      .max(1000),
  })
  .strict()
  .refine(
    (value) => new Set(value.deviceIds).size === value.deviceIds.length,
    "deviceIds must be unique",
  );
const statusInput = z
  .object({
    messageId: z.string().uuid(),
    deviceId: z.string().regex(/^AG-[0-9]{6}$/),
    releaseId: z.string().uuid(),
    status: z.enum([
      "NOTIFIED",
      "DOWNLOADING",
      "DOWNLOADED",
      "VERIFIED",
      "INSTALLING",
      "PENDING_BOOT_VALIDATION",
      "SUCCEEDED",
      "FAILED",
      "ROLLED_BACK",
      "REJECTED",
    ]),
    progressPercent: z.number().int().min(0).max(100),
    downloadedBytes: z.number().int().min(0).max(2_147_483_648),
    reportedAt: z.string().datetime(),
    runningVersion: z.string().min(1).max(64),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        path: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (["FAILED", "REJECTED"].includes(value.status) && !value.error)
      context.addIssue({
        code: "custom",
        message: "failed status requires error",
      });
  });

export interface RouteDependencies {
  repository: OtaRepository;
  objectStorage: ObjectStorage;
  authenticate?: Authenticator;
  authorize?: OtaAuthorizer;
  deviceProvider?: DeviceProvider;
}
function correlationId(request: Request) {
  return (
    z.string().uuid().safeParse(request.header("x-correlation-id")).data ??
    randomUUID()
  );
}
function sameRelease(one: Release, two: z.infer<typeof releaseInput>) {
  return (
    one.releaseId === two.releaseId &&
    one.version === two.version &&
    one.hardwareModel === two.hardwareModel &&
    one.objectKey === two.objectKey &&
    one.sizeBytes === two.sizeBytes &&
    one.sha256 === two.sha256 &&
    one.signature === two.signature &&
    one.signatureAlgorithm === two.signatureAlgorithm
  );
}

export function createRouter(dependencies: RouteDependencies) {
  const router = Router();
  const authenticate = dependencies.authenticate ?? createAuthenticator();
  const authorize = dependencies.authorize ?? createOtaAuthorizer();
  const deviceProvider = dependencies.deviceProvider ?? createDeviceProvider();

  router.post("/firmware/releases", async (request, response) => {
    const principal = await authenticate(request.header("authorization"));
    if (
      !principal.service ||
      principal.clientId !== "algaguard-firmware-release"
    )
      throw new HttpError(403, "Firmware release service token required");
    const input = releaseInput.parse(request.body);
    if (!(await dependencies.objectStorage.verifyObject(input)))
      throw new HttpError(
        422,
        "Object size, SHA-256, or signature verification failed",
      );
    const result = await dependencies.repository.createRelease({
      ...input,
      createdBy: principal.subjectId,
    });
    if (!sameRelease(result.release, input))
      throw new HttpError(409, "releaseId is immutable");
    response.status(result.created ? 201 : 200).json(result.release);
  });
  router.get("/firmware/releases", async (request, response) => {
    await authenticate(request.header("authorization"));
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .parse(request.query.limit);
    response.json({
      items: await dependencies.repository.listReleases(limit),
      page: {},
    });
  });
  router.get("/firmware/releases/:id", async (request, response) => {
    await authenticate(request.header("authorization"));
    const release = await dependencies.repository.getRelease(
      z.string().uuid().parse(request.params.id),
    );
    if (!release) throw new HttpError(404, "Release not found");
    response.json(release);
  });
  router.post("/ota/rollouts", async (request, response) => {
    const authorization = z.string().parse(request.header("authorization"));
    const principal = await authenticate(authorization);
    const input = rolloutInput.parse(request.body);
    const release = await dependencies.repository.getRelease(input.releaseId);
    if (!release) throw new HttpError(404, "Release not found");
    const devices = [];
    const organizations = new Set<string>();
    for (const deviceId of input.deviceIds) {
      const decision = await authorize(
        principal.subjectId,
        "ota.manage",
        deviceId,
        correlationId(request),
      );
      if (!decision.allowed || !decision.organizationId)
        throw new HttpError(
          403,
          `OTA rollout is not authorized for ${deviceId}`,
        );
      organizations.add(decision.organizationId);
      const device = await deviceProvider(
        deviceId,
        authorization,
        correlationId(request),
      );
      if (!eligible(release, device))
        throw new HttpError(409, `Device ${deviceId} is not eligible`);
      devices.push(device);
    }
    if (organizations.size !== 1)
      throw new HttpError(403, "A rollout cannot cross organizations");
    const rollout = await dependencies.repository.createRollout({
      releaseId: release.releaseId,
      ring: input.rolloutRing,
      createdBy: principal.subjectId,
      devices,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    response
      .status(201)
      .json({ rolloutId: rollout.rolloutId, status: rollout.status });
  });
  router.get("/devices/:id/assignment", async (request, response) => {
    const principal = await authenticate(request.header("authorization"));
    const deviceId = z
      .string()
      .regex(/^AG-[0-9]{6}$/)
      .parse(request.params.id);
    if (principal.subjectId !== deviceId) {
      const decision = await authorize(
        principal.subjectId,
        "ota.read",
        deviceId,
        correlationId(request),
      );
      if (!decision.allowed)
        throw new HttpError(403, "OTA assignment read is not authorized");
    }
    const assignment = await dependencies.repository.assignmentFor(deviceId);
    if (!assignment) throw new HttpError(404, "Active assignment not found");
    const release = await dependencies.repository.getRelease(
      assignment.releaseId,
    );
    if (!release) throw new HttpError(404, "Release not found");
    const ttl = Math.min(
      300,
      Math.max(
        1,
        Math.floor((Date.parse(assignment.expiresAt) - Date.now()) / 1000),
      ),
    );
    const downloadUrl = await dependencies.objectStorage.temporaryDownloadUrl(
      release.objectKey,
      ttl,
    );
    response.json({ assignment, release, downloadUrl, expiresInSeconds: ttl });
  });
  router.post("/assignments/:id/status", async (request, response) => {
    const principal = await authenticate(request.header("authorization"));
    const assignmentId = z.string().uuid().parse(request.params.id);
    const input = statusInput.parse(request.body);
    if (
      principal.subjectId !== input.deviceId &&
      principal.clientId !== "algaguard-mqtt-ingestion-service"
    )
      throw new HttpError(403, "Device or ingestion service token required");
    const result = await dependencies.repository.recordStatus({
      assignmentId,
      messageId: input.messageId,
      deviceId: input.deviceId,
      releaseId: input.releaseId,
      status: input.status,
      progressPercent: input.progressPercent,
      downloadedBytes: input.downloadedBytes,
      reportedAt: input.reportedAt,
      runningVersion: input.runningVersion,
      ...(input.error
        ? {
            error: {
              code: input.error.code,
              message: input.error.message,
              retryable: input.error.retryable,
              ...(input.error.path ? { path: input.error.path } : {}),
            },
          }
        : {}),
    });
    if (!result) throw new HttpError(409, "Stale or mismatched OTA assignment");
    response.json(result);
  });
  return router;
}
