import { createPostgresPool } from "./adapters.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PostgresOtaRepository } from "./repository.js";
import { MinioObjectStorage } from "./storage.js";
import { MqttOtaNotifier } from "./transport.js";
const config = loadConfig();
const repository = new PostgresOtaRepository(createPostgresPool(config));
const objectStorage = new MinioObjectStorage();
const notifier = await MqttOtaNotifier.connect(config);
const server = buildApp(
  repository,
  objectStorage,
  undefined,
  undefined,
  undefined,
  notifier,
).listen(config.PORT, () => {
  process.stdout.write(
    `${JSON.stringify({ level: "info", service: "algaguard-ota-service", message: "listening", port: config.PORT })}\n`,
  );
});
async function shutdown(signal: string) {
  process.stdout.write(
    `${JSON.stringify({ level: "info", service: "algaguard-ota-service", message: "shutdown", signal })}\n`,
  );
  await repository.close();
  await notifier.close();
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
