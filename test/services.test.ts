import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceProvider } from "../src/services.js";

test("OTA device lookup resolves canonical UUID before authorized device read", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      ...(headers.get("authorization")
        ? { authorization: headers.get("authorization")! }
        : {}),
    });
    if (url.endsWith("/protocol/openid-connect/token"))
      return Response.json({ access_token: "service-token", expires_in: 60 });
    if (url.includes("/internal/devices/by-device-id/"))
      return Response.json({
        deviceUuid: "10000000-0000-4000-8000-000000000001",
        deviceId: "AG-000001",
      });
    return Response.json({
      deviceId: "AG-000001",
      hardwareModel: "ESP32-S3-N16R8",
      firmwareVersion: "1.0.0",
    });
  };
  try {
    const result = await createDeviceProvider({
      KEYCLOAK_ISSUER: "http://keycloak/realms/algaguard",
      SERVICE_CLIENT_ID: "algaguard-ota-service",
      SERVICE_CLIENT_SECRET: "test-secret",
      DEVICE_SERVICE_URL: "http://device-service:3000",
    })("AG-000001", "Bearer human-token", crypto.randomUUID());
    assert.equal(result.deviceId, "AG-000001");
    assert.equal(calls.length, 3);
    assert.match(calls[1]!.url, /by-device-id\/AG-000001\/context$/);
    assert.equal(calls[1]!.authorization, "Bearer service-token");
    assert.match(
      calls[2]!.url,
      /\/devices\/10000000-0000-4000-8000-000000000001$/,
    );
    assert.equal(calls[2]!.authorization, "Bearer human-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
