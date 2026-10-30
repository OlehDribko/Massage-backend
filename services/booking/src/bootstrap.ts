import { Router, type Express } from "express";
import type { Database } from "./shared/database/database.js";
import { createApp } from "./app.js";
import type { AppConfig } from "./config/config.js";
import { createReadinessProbe } from "./http/health.js";
import { createAuthenticate } from "./http/auth/authenticate.js";
import { createFirebaseIdentityProvider } from "./integrations/firebase/firebase-identity-provider.js";
import type { Logger } from "./logging/logger.js";
import { createAccessGuards } from "./modules/access/require-access.js";
import type { IdentityProvider } from "./modules/auth/identity.js";
import { createAdminBookingRouter, createClientBookingRouter } from "./modules/bookings/booking.routes.js";
import { createBookingService } from "./modules/bookings/booking.service.js";
import { createAdminCatalogRouter, createPublicCatalogRouter } from "./modules/catalog/catalog.routes.js";
import { createCatalogService } from "./modules/catalog/catalog.service.js";
import { createBrevoMarketingMailer, type MarketingMailer } from "./modules/email/service/email.service.js";
import { createActionTokenService } from "./modules/email/tokens/action-token.service.js";
import { createMarketingRepository } from "./modules/marketing/marketing.repository.js";
import { createMarketingRouter } from "./modules/marketing/marketing.routes.js";
import { createMarketingService } from "./modules/marketing/marketing.service.js";
import { createProfileRepository } from "./modules/profiles/profile.repository.js";
import { createProfileRouter } from "./modules/profiles/profile.routes.js";
import { createProfileService } from "./modules/profiles/profile.service.js";
import { createPublicAvailabilityRouter } from "./modules/schedule/availability.routes.js";
import { DEFAULT_BOOKING_RULES, type BookingRules } from "./modules/schedule/booking-rules.js";
import { createCalendarTransaction } from "./modules/schedule/calendar-transaction.js";
import { createAdminScheduleRouter } from "./modules/schedule/schedule.routes.js";
import { createScheduleService } from "./modules/schedule/schedule.service.js";

/** Replacements for external services (tests only). */
export type ApplicationOverrides = {
  identityProvider?: IdentityProvider;
  marketingMailer?: MarketingMailer;
  /** Server clock for the booking calendar. */
  now?: () => Date;
  bookingRules?: BookingRules;
};

/**
 * Composes the application from validated config:
 * - public catalogue and availability (/api/services) always: read-only,
 *   no token;
 * - /api/me (profiles), /api/bookings and /api/admin only when Firebase is
 *   configured; without it those routes do not exist (fail closed);
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

  const now = overrides.now ?? (() => new Date());
  const rules = overrides.bookingRules ?? DEFAULT_BOOKING_RULES;
  const calendar = createCalendarTransaction(database.prisma);
  const catalog = createCatalogService({ prisma: database.prisma, calendar, now });
  api.use(
    "/services/:serviceId/availability",
    createPublicAvailabilityRouter({ prisma: database.prisma, catalog, rules, now }),
  );
  api.use("/services", createPublicCatalogRouter(catalog));

  const marketingRepository = createMarketingRepository(database.prisma);
  const marketingService =
    config.marketing === undefined
      ? undefined
      : createMarketingService({
          repository: marketingRepository,
          mailer:
            overrides.marketingMailer ??
            createBrevoMarketingMailer({
              brevoApiKey: config.marketing.brevoApiKey,
              fromName: config.marketing.emailFromName,
              fromEmail: config.marketing.emailFromEmail,
            }),
          tokens: createActionTokenService(config.marketing.actionTokenSecret),
          frontendUrl: config.marketing.frontendUrl,
          logger,
        });

  if (config.firebase !== undefined) {
    const identityProvider =
      overrides.identityProvider ?? createFirebaseIdentityProvider(config.firebase, logger);
    const profiles = createProfileService(createProfileRepository(database.prisma));
    const authenticate = createAuthenticate(identityProvider);
    const guards = createAccessGuards(profiles);
    api.use(
      "/me",
      createProfileRouter({
        authenticate,
        profiles,
        identityProvider,
        marketing: { repository: marketingRepository, service: marketingService },
        logger,
      }),
    );

    const bookings = createBookingService({ prisma: database.prisma, calendar, rules, now });
    api.use("/bookings", authenticate, createClientBookingRouter({ bookings, guards, rules, now }));

    // Administration lives in the owning modules; every route needs a
    // verified admin, checked on the server for each request.
    const admin = Router();
    admin.use("/services", createAdminCatalogRouter(catalog));
    admin.use(
      "/schedule",
      createAdminScheduleRouter({
        schedule: createScheduleService({ prisma: database.prisma, calendar, rules, now }),
        rules,
        now,
      }),
    );
    admin.use("/bookings", createAdminBookingRouter({ bookings, rules, now }));
    api.use("/admin", authenticate, guards.requireAdmin, admin);
  }

  if (marketingService !== undefined) {
    api.use("/marketing", createMarketingRouter(marketingService));
  }

  return createApp({
    logger,
    isShuttingDown,
    probeReadiness,
    appVersion: config.appVersion,
    corsOrigin: config.corsOrigin,
    apiRouter: api,
  });
};
