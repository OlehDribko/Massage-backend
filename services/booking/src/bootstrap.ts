import { Router, type Express } from "express";
import type { Database } from "./shared/database/database.js";
import { createApp } from "./app.js";
import type { AppConfig } from "./config/config.js";
import { createReadinessProbe } from "./http/health.js";
import { createAuthenticate } from "./http/auth/authenticate.js";
import { createFirebaseIdentityProvider } from "./integrations/firebase/firebase-identity-provider.js";
import type { Logger } from "./logging/logger.js";
import type { IdentityProvider } from "./modules/auth/identity.js";
import { createBrevoMarketingMailer, type MarketingMailer } from "./modules/email/service/email.service.js";
import { createActionTokenService } from "./modules/email/tokens/action-token.service.js";
import { createMarketingRepository } from "./modules/marketing/marketing.repository.js";
import { createMarketingRouter } from "./modules/marketing/marketing.routes.js";
import { createMarketingService } from "./modules/marketing/marketing.service.js";
import { createProfileRepository } from "./modules/profiles/profile.repository.js";
import { createProfileRouter } from "./modules/profiles/profile.routes.js";
import { createProfileService } from "./modules/profiles/profile.service.js";

/** Replacements for external services (tests only). */
export type ApplicationOverrides = {
  identityProvider?: IdentityProvider;
  marketingMailer?: MarketingMailer;
};

/**
 * Composes the application from validated config:
 * - /api/me (profiles) only when Firebase is configured; without it the
 *   routes do not exist, so nothing is reachable unauthenticated;
 * - /api/marketing only when ENABLE_MARKETING_SUBSCRIPTION=true.
 * External clients (Firebase Admin SDK, Brevo) are created here, not on import.
 */
export const createApplication = ({
  config,
  logger,
  database,
  isShuttingDown,
  overrides = {},
}: {
  config: AppConfig;
  logger: Logger;
  database: Database;
  isShuttingDown: () => boolean;
  overrides?: ApplicationOverrides;
}): Express => {
  // (a) Promise.race in the probe bounds the HTTP response time;
  // (b) query_timeout makes the driver fail the hung query itself;
  // (c) the pool then destroys that connection, so the next probe starts a
  //     fresh query instead of waiting on the old one.
  const probeReadiness = createReadinessProbe(
    () => database.ping(config.readinessTimeoutMs),
    config.readinessTimeoutMs,
  );

  const api = Router();
  let hasApiRoutes = false;

  if (config.firebase !== undefined) {
    const identityProvider =
      overrides.identityProvider ?? createFirebaseIdentityProvider(config.firebase, logger);
    const profiles = createProfileService(createProfileRepository(database.prisma));
    api.use(
      "/me",
      createProfileRouter({
        authenticate: createAuthenticate(identityProvider),
        profiles,
        identityProvider,
      }),
    );
    hasApiRoutes = true;
  }

  if (config.marketing !== undefined) {
    const marketing = config.marketing;
    const service = createMarketingService({
      repository: createMarketingRepository(database.prisma),
      mailer:
        overrides.marketingMailer ??
        createBrevoMarketingMailer({
          brevoApiKey: marketing.brevoApiKey,
          fromName: marketing.emailFromName,
          fromEmail: marketing.emailFromEmail,
        }),
      tokens: createActionTokenService(marketing.actionTokenSecret),
      frontendUrl: marketing.frontendUrl,
      logger,
    });
    api.use("/marketing", createMarketingRouter(service));
    hasApiRoutes = true;
  }

  return createApp({
    logger,
    isShuttingDown,
    probeReadiness,
    appVersion: config.appVersion,
    corsOrigin: config.corsOrigin,
    apiRouter: hasApiRoutes ? api : undefined,
  });
};
