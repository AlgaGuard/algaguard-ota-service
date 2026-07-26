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
