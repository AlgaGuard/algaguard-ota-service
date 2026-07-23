import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import mqtt, { type MqttClient } from "mqtt";
import type { ServiceConfig } from "./config.js";
import type { Assignment, OtaNotifier, Release } from "./domain.js";

export function otaNotification(
  assignment: Assignment,
  release: Release,
  downloadUrl: string,
) {
  return {
    schema: "urn:algaguard:schema:mqtt:ota-notification:v1",
    schemaVersion: "1.0.0",
    messageId: randomUUID(),
    deviceId: assignment.deviceId,
    sentAt: new Date().toISOString(),
    payload: {
      releaseId: release.releaseId,
      version: release.version,
      hardwareModel: release.hardwareModel,
      downloadUrl,
      sizeBytes: release.sizeBytes,
      sha256: release.sha256,
      signature: release.signature,
      signatureAlgorithm: release.signatureAlgorithm,
      publishedAt: release.publishedAt,
      expiresAt: assignment.expiresAt,
      rolloutRing: assignment.rolloutRing,
      mandatory: false,
    },
  } as const;
}

export class MqttOtaNotifier implements OtaNotifier {
  private constructor(private readonly client: MqttClient) {}

  static async connect(config: ServiceConfig) {
    const [ca, cert, key] = await Promise.all([
      readFile(config.MQTT_CA_PATH),
      readFile(config.MQTT_CERTIFICATE_PATH),
      readFile(config.MQTT_PRIVATE_KEY_PATH),
    ]);
    const client = await mqtt.connectAsync(config.MQTT_URL, {
      clientId: config.MQTT_CLIENT_ID,
      ca,
      cert,
      key,
      servername: config.MQTT_SERVER_NAME,
      rejectUnauthorized: true,
      protocolVersion: 5,
      clean: false,
      keepalive: config.MQTT_KEEPALIVE_SECONDS,
      reconnectPeriod: config.MQTT_RECONNECT_DELAY_MS,
      queueQoSZero: false,
      properties: {
        receiveMaximum: config.MQTT_QOS1_INFLIGHT,
        sessionExpiryInterval: config.MQTT_SESSION_EXPIRY_SECONDS,
      },
    });
    return new MqttOtaNotifier(client);
  }

  async publish(assignment: Assignment, release: Release, downloadUrl: string) {
    await this.client.publishAsync(
      `algaguard/v1/devices/${assignment.deviceId}/ota`,
      JSON.stringify(otaNotification(assignment, release, downloadUrl)),
      { qos: 1, retain: false },
    );
  }

  async close() {
    await this.client.endAsync();
  }
}
