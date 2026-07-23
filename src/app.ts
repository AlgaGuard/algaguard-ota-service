import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import { trace } from "@opentelemetry/api";
import pino from "pino";
import { z } from "zod";
import { HttpError, type Authenticator } from "./auth.js";
import type { ObjectStorage, OtaNotifier, OtaRepository } from "./domain.js";
import { createRouter } from "./routes.js";
import type { DeviceProvider, OtaAuthorizer } from "./services.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const requestContext: RequestHandler = (request, response, next) => {
  const supplied = request.header("x-correlation-id");
  const correlationId =
    supplied && supplied.length <= 128 ? supplied : randomUUID();
  response.setHeader("x-correlation-id", correlationId);
  request.headers["x-correlation-id"] = correlationId;
  const span = trace
    .getTracer("algaguard-ota-service")
    .startSpan(`${request.method} ${request.path}`);
  const startedAt = Date.now();
  response.on("finish", () => {
    logger.info(
      {
        correlationId,
        method: request.method,
        path: request.path,
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
      },
      "request completed",
    );
    span.end();
  });
  next();
};

export function buildApp(
  repository: OtaRepository,
  objectStorage: ObjectStorage,
  authenticate?: Authenticator,
  authorize?: OtaAuthorizer,
  deviceProvider?: DeviceProvider,
  notifier?: OtaNotifier,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use(requestContext);
  app.get("/health/live", (_request, response) =>
    response.json({ status: "UP", service: "algaguard-ota-service" }),
  );
  app.get("/health/ready", async (_request, response) => {
    try {
      await Promise.all([repository.health(), objectStorage.health()]);
      response.json({
        status: "READY",
        service: "algaguard-ota-service",
        dependencies: { postgres: "UP", objectStorage: "UP" },
      });
    } catch {
      response
        .status(503)
        .json({ status: "NOT_READY", service: "algaguard-ota-service" });
    }
  });
  app.use(
    "/v1",
    createRouter({
      repository,
      objectStorage,
      ...(authenticate ? { authenticate } : {}),
      ...(authorize ? { authorize } : {}),
      ...(deviceProvider ? { deviceProvider } : {}),
      ...(notifier ? { notifier } : {}),
    }),
  );
  app.use((_request, response) =>
    response
      .status(404)
      .type("application/problem+json")
      .json({ type: "about:blank", title: "Not Found", status: 404 }),
  );
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    logger.error({ err: error }, "request failed");
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 500;
    response
      .status(status)
      .type("application/problem+json")
      .json({
        type: "about:blank",
        title:
          status === 400
            ? "Bad Request"
            : status === 401
              ? "Unauthorized"
              : status === 403
                ? "Forbidden"
                : status === 404
                  ? "Not Found"
                  : status === 409
                    ? "Conflict"
                    : status === 422
                      ? "Unprocessable Content"
                      : "Internal Server Error",
        status,
      });
  };
  app.use(errors);
  return app;
}
