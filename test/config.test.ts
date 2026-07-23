import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgresql://localhost/algaguard",
  MQTT_URL: "mqtts://broker:8884",
  MQTT_CA_PATH: "/run/pki/ca.crt",
  MQTT_CERTIFICATE_PATH: "/run/pki/ota.crt",
  MQTT_PRIVATE_KEY_PATH: "/run/pki/ota.key",
  MQTT_SERVER_NAME: "broker",
};

test("OTA notification transport requires TLS and bounded settings", () => {
  const config = loadConfig(valid);
  assert.equal(config.MQTT_CLIENT_ID, "algaguard-ota-service");
  assert.equal(config.MQTT_QOS1_INFLIGHT, 32);
  assert.throws(() => loadConfig({ ...valid, MQTT_URL: "mqtt://broker:1883" }));
  assert.throws(() => loadConfig({ ...valid, MQTT_RECONNECT_DELAY_MS: "0" }));
});
