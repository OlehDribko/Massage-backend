import express from "express";
import type { Express, Router } from "express";
import cors from "cors";
import { createErrorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { createRequestLogging } from "./http/request-logging.js";
import { createHealthRouter, type ReadinessOutcome } from "./http/health.js";
import { createDocsRouter } from "./openapi/docs-router.js";
import type { Logger } from "./logging/logger.js";

/**
 * JSON body limit. The largest current payload (profile update: name ≤ 80 and
 * a phone number, or an action token of a few hundred bytes) is far below
 * 1 kB; 16 kB leaves headroom while rejecting oversized bodies early.
 */
export const JSON_BODY_LIMIT = "16kb";

export type AppDeps = {
  logger: Logger;
  isShuttingDown: () => boolean;
  probeReadiness: () => Promise<ReadinessOutcome>;
  appVersion: string | undefined;
  corsOrigin: string | undefined;
  /** Business routes under /api; undefined when none is enabled. */
  apiRouter: Router | undefined;
  /** /openapi.json and /docs (Swagger UI); absent when false or omitted. */
  apiDocs?: boolean | undefined;
};

/** Builds the Express app. Does not open a port. */
export const createApp = (deps: AppDeps): Express => {
  const app = express();

  app.disable("x-powered-by");

  app.use(createRequestLogging(deps.logger));

  // CORS headers only for the configured frontend origin; none otherwise.
  if (deps.corsOrigin !== undefined) {
    app.use(cors({ origin: deps.corsOrigin }));
  }

  app.use(
    "/health",
    createHealthRouter({
      isShuttingDown: deps.isShuttingDown,
      probeReadiness: deps.probeReadiness,
      appVersion: deps.appVersion,
    }),
  );

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  if (deps.apiRouter !== undefined) {
    app.use("/api", deps.apiRouter);
  }

  if (deps.apiDocs === true) {
    app.use(createDocsRouter());
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));

  return app;
};
