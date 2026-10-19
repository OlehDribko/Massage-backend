import type { Database } from "./shared/database/database.js";
import type { Express } from "express";
import { createApp } from "./app.js";
import type { AppConfig } from "./config/config.js";
import { createReadinessProbe } from "./http/health.js";
import type { Logger } from "./logging/logger.js";
import { createLegacyUserRouter } from "./modules/users/legacy-user-routes.js";

/**
 * Composes the application from validated config. Legacy /api/users routes
 * (and the Brevo client) are created only when ENABLE_LEGACY_USER_ROUTES=true.
 */
export const createApplication = ({
  config,
  logger,
  database,
  isShuttingDown,
}: {
  config: AppConfig;
  logger: Logger;
  database: Database;
  isShuttingDown: () => boolean;
}): Express => {
  // (a) Promise.race in the probe bounds the HTTP response time;
  // (b) query_timeout makes the driver fail the hung query itself;
  // (c) the pool then destroys that connection, so the next probe starts a
  //     fresh query instead of waiting on the old one.
  const probeReadiness = createReadinessProbe(
    () => database.ping(config.readinessTimeoutMs),
    config.readinessTimeoutMs,
  );

  const legacyUserRouter = config.legacyUserRoutes.enabled
    ? createLegacyUserRouter({ prisma: database.prisma, config: config.legacyUserRoutes, logger })
    : undefined;

  return createApp({
    logger,
    isShuttingDown,
    probeReadiness,
    appVersion: config.appVersion,
    corsOrigin: config.corsOrigin,
    legacyUserRouter,
  });
};
