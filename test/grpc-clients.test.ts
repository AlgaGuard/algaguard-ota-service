import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  createGrpcDeviceProvider,
  createGrpcOtaAuthorizer,
} from "../src/services.js";

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

function withFakeTokenEndpoint(
  testFn: (environment: NodeJS.ProcessEnv) => Promise<void>,
) {
  return async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      if (String(input).includes("/protocol/openid-connect/token"))
        return new Response(
          JSON.stringify({ access_token: "fake-token", expires_in: 300 }),
          { status: 200 },
        );
      return originalFetch(input);
    }) as typeof fetch;
    try {
      await testFn({
        KEYCLOAK_TOKEN_URL:
          "https://keycloak.test/protocol/openid-connect/token",
        SERVICE_CLIENT_SECRET: "test-secret",
        SERVICE_CLIENT_ID: "algaguard-ota-service",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
}

test(
  "createGrpcOtaAuthorizer calls Decide with a service token and maps resolvedOrganizationId",
  withFakeTokenEndpoint(async (environment) => {
    const proto = loadProto("access_service.proto");
    const received: any[] = [];
    const organizationId = randomUUID();
    const server = new grpc.Server();
    server.addService(proto.algaguard.access.v1.AuthorizationService.service, {
      decide(
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>,
      ) {
        received.push({
          request: call.request,
          authorization: call.metadata.get("authorization")[0],
          correlationId: call.metadata.get("x-correlation-id")[0],
        });
        callback(null, {
          allowed: true,
          reason: "",
          decidedAt: new Date().toISOString(),
          ttlSeconds: 5,
          resolvedOrganizationId: organizationId,
        });
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
      );
    });
    try {
      const authorize = createGrpcOtaAuthorizer(
        `127.0.0.1:${port}`,
        environment,
      );
      const decision = await authorize(
        "owner",
        "ota.manage",
        "AG-000001",
        "correlation-1",
      );
      assert.equal(decision.allowed, true);
      assert.equal(decision.organizationId, organizationId);
      assert.equal(received[0]?.authorization, "Bearer fake-token");
      assert.equal(received[0]?.correlationId, "correlation-1");
      assert.equal(received[0]?.request.resourceType, 2); // device
      assert.equal(received[0]?.request.action, "ota.manage");
    } finally {
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    }
  }),
);

test(
  "createGrpcDeviceProvider resolves context with a service token then forwards the caller's own token to GetDevice",
  withFakeTokenEndpoint(async (environment) => {
    const proto = loadProto("device_service.proto");
    const deviceUuid = randomUUID();
    const seen: { getContextByDeviceId?: string; getDevice?: string } = {};
    const server = new grpc.Server();
    server.addService(proto.algaguard.device.v1.DeviceLookupService.service, {
      getContextByDeviceId(
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>,
      ) {
        seen.getContextByDeviceId = call.metadata.get(
          "authorization",
        )[0] as string;
        callback(null, {
          deviceUuid,
          deviceId: call.request.deviceId,
          organizationId: randomUUID(),
          status: 5,
          ownershipVersion: "1",
          resolvedAt: new Date().toISOString(),
          tankId: "",
          contextVersion: "1",
        });
      },
      getDevice(
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>,
      ) {
        seen.getDevice = call.metadata.get("authorization")[0] as string;
        callback(null, {
          deviceUuid: call.request.deviceUuid,
          deviceId: "AG-000001",
          displayName: "",
          organizationId: randomUUID(),
          tankId: "",
          hardwareModel: "ESP32-S3-DEVKITC-1-N16R8",
          firmwareVersion: "1.2.3",
          lifecycle: "ACTIVE",
          ownershipVersion: "1",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (error, boundPort) => (error ? reject(error) : resolve(boundPort)),
      );
    });
    try {
      const provider = createGrpcDeviceProvider(
        `127.0.0.1:${port}`,
        environment,
      );
      const device = await provider(
        "AG-000001",
        "Bearer caller-own-token",
        "correlation-1",
      );
      assert.equal(device.deviceId, "AG-000001");
      assert.equal(device.hardwareModel, "ESP32-S3-DEVKITC-1-N16R8");
      assert.equal(device.firmwareVersion, "1.2.3");
      assert.equal(seen.getContextByDeviceId, "Bearer fake-token");
      assert.equal(seen.getDevice, "Bearer caller-own-token");
    } finally {
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    }
  }),
);
