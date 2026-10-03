import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  createServiceTokenProvider,
  metadataWithServiceToken,
} from "./grpc-client.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function loadProto(file: string) {
  const protoPath = path.resolve(here, "..", "proto", file);
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(protoPath)],
  });
  return grpc.loadPackageDefinition(packageDefinition) as any;
}

export type OtaAuthorizer = (
  subjectId: string,
  action: "ota.manage" | "ota.read",
  deviceId: string,
  correlationId: string,
) => Promise<{ allowed: boolean; organizationId?: string }>;
export type DeviceProvider = (
  deviceId: string,
  authorization: string,
  correlationId: string,
) => Promise<{
  deviceId: string;
  hardwareModel: string;
  firmwareVersion: string;
}>;

let token: { value: string; expiresAt: number } | undefined;
async function serviceToken(environment: NodeJS.ProcessEnv) {
  if (token && token.expiresAt > Date.now() + 10_000) return token.value;
  const tokenUrl = environment.KEYCLOAK_TOKEN_URL;
  if (!tokenUrl) throw new Error("KEYCLOAK_TOKEN_URL is required");
  if (!environment.SERVICE_CLIENT_SECRET)
    throw new Error("SERVICE_CLIENT_SECRET is required");
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: environment.SERVICE_CLIENT_ID ?? "algaguard-ota-service",
      client_secret: environment.SERVICE_CLIENT_SECRET,
    }),
  });
  if (!response.ok) throw new Error("OTA service authentication failed");
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) throw new Error("Service token response invalid");
  token = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 30) * 1000,
  };
  return token.value;
}
export function createOtaAuthorizer(
  environment: NodeJS.ProcessEnv = process.env,
): OtaAuthorizer {
  const base = environment.ACCESS_SERVICE_URL ?? "http://access-service:3000";
  return async (subjectId, action, deviceId, correlationId) => {
    const response = await fetch(`${base}/v1/internal/authorizations/decide`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await serviceToken(environment)}`,
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify({
        subjectId,
        action,
        resourceType: "device",
        resourceId: deviceId,
      }),
    });
    if (!response.ok)
      throw new Error(`Access authorization failed with ${response.status}`);
    return (await response.json()) as {
      allowed: boolean;
      organizationId?: string;
    };
  };
}
export function createDeviceProvider(
  environment: NodeJS.ProcessEnv = process.env,
): DeviceProvider {
  const base = environment.DEVICE_SERVICE_URL ?? "http://device-service:3000";
  return async (deviceId, authorization, correlationId) => {
    const contextResponse = await fetch(
      `${base}/v1/internal/devices/by-device-id/${deviceId}/context`,
      {
        headers: {
          authorization: `Bearer ${await serviceToken(environment)}`,
          "x-correlation-id": correlationId,
        },
      },
    );
    if (!contextResponse.ok)
      throw new Error(
        `Device context lookup failed with ${contextResponse.status}`,
      );
    const context = (await contextResponse.json()) as {
      deviceUuid?: string;
      deviceId?: string;
    };
    if (!context.deviceUuid || context.deviceId !== deviceId)
      throw new Error("Device context identity is invalid");
    const response = await fetch(`${base}/v1/devices/${context.deviceUuid}`, {
      headers: { authorization, "x-correlation-id": correlationId },
    });
    if (!response.ok)
      throw new Error(`Device lookup failed with ${response.status}`);
    return (await response.json()) as {
      deviceId: string;
      hardwareModel: string;
      firmwareVersion: string;
    };
  };
}

export function createGrpcOtaAuthorizer(
  address: string,
  environment: NodeJS.ProcessEnv = process.env,
  serviceToken = createServiceTokenProvider(environment),
): OtaAuthorizer {
  const proto = loadProto("access_service.proto");
  const client = new proto.algaguard.access.v1.AuthorizationService(
    address,
    grpc.credentials.createInsecure(),
  );
  return async (subjectId, action, deviceId, correlationId) => {
    const metadata = await metadataWithServiceToken(serviceToken, {
      "x-correlation-id": correlationId,
    });
    const response = await new Promise<any>((resolve, reject) => {
      client.decide(
        {
          subjectId,
          action,
          resourceType: 2, // device
          resourceId: deviceId,
        },
        metadata,
        (error: grpc.ServiceError, value: unknown) =>
          error ? reject(error) : resolve(value),
      );
    });
    return {
      allowed: response.allowed === true,
      ...(response.resolvedOrganizationId
        ? { organizationId: response.resolvedOrganizationId }
        : {}),
    };
  };
}

export function createGrpcDeviceProvider(
  address: string,
  environment: NodeJS.ProcessEnv = process.env,
  serviceToken = createServiceTokenProvider(environment),
): DeviceProvider {
  const proto = loadProto("device_service.proto");
  const client = new proto.algaguard.device.v1.DeviceLookupService(
    address,
    grpc.credentials.createInsecure(),
  );
  return async (deviceId, authorization, correlationId) => {
    const contextMetadata = await metadataWithServiceToken(serviceToken, {
      "x-correlation-id": correlationId,
    });
    const context = await new Promise<any>((resolve, reject) => {
      client.getContextByDeviceId(
        { deviceId },
        contextMetadata,
        (error: grpc.ServiceError, value: unknown) =>
          error ? reject(error) : resolve(value),
      );
    });
    if (!context.deviceUuid || context.deviceId !== deviceId)
      throw new Error("Device context identity is invalid");
    // GetDevice, unlike GetContextByDeviceId, authorizes the ORIGINAL
    // caller's own device.read permission (matching the HTTP route this
    // replaces), so it gets the caller's own bearer token, not a service
    // token.
    const deviceMetadata = new grpc.Metadata();
    deviceMetadata.set("authorization", authorization);
    deviceMetadata.set("x-correlation-id", correlationId);
    const device = await new Promise<any>((resolve, reject) => {
      client.getDevice(
        { deviceUuid: context.deviceUuid },
        deviceMetadata,
        (error: grpc.ServiceError, value: unknown) =>
          error ? reject(error) : resolve(value),
      );
    });
    return {
      deviceId: device.deviceId,
      hardwareModel: device.hardwareModel,
      firmwareVersion: device.firmwareVersion,
    };
  };
}
