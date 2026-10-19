import type { PrismaClient } from "@prisma/client";
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
  prisma,
  isShuttingDown,
}: {
  config: AppConfig;
  logger: Logger;
  prisma: PrismaClient;
  isShuttingDown: () => boolean;
}): Express => {
  const probeReadiness = createReadinessProbe(
    () => prisma.$queryRaw`SELECT 1`,
    config.readinessTimeoutMs,
  );

  const legacyUserRouter = config.legacyUserRoutes.enabled
    ? createLegacyUserRouter({ prisma, config: config.legacyUserRoutes, logger })
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
