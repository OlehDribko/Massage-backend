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
import { createPublicCatalogRouter } from "./modules/catalog/catalog.routes.js";
import { createCatalogService } from "./modules/catalog/catalog.service.js";
import { createBrevoMarketingMailer, type MarketingMailer } from "./modules/email/service/email.service.js";
import { createActionTokenService } from "./modules/email/tokens/action-token.service.js";
import { createMarketingRepository } from "./modules/marketing/marketing.repository.js";
import { createMarketingRouter } from "./modules/marketing/marketing.routes.js";
import { createMarketingService } from "./modules/marketing/marketing.service.js";
import { createNotificationStatusReader } from "./notifications/status.js";
import { createProfileRepository } from "./modules/profiles/profile.repository.js";
import { createProfileRouter } from "./modules/profiles/profile.routes.js";
import { createProfileService } from "./modules/profiles/profile.service.js";
import { createPublicAvailabilityRouter } from "./modules/schedule/availability.routes.js";
import { DEFAULT_BOOKING_RULES, type BookingRules } from "./modules/schedule/booking-rules.js";
import { createCalendarTransaction, type CalendarTransaction } from "./modules/schedule/calendar-transaction.js";
import { createAdminScheduleRouter } from "./modules/schedule/schedule.routes.js";
import { createScheduleService } from "./modules/schedule/schedule.service.js";

/**
 * Booking notifications running in this process (server.ts creates the
 * dispatcher). Absent: notifications are off; booking views then carry no
 * notification status.
 */
export type NotificationsRuntime = {
  /** Called after every booking write, committed or not; must not throw or block. */
  wake: () => void;
};

/**
 * Wraps the calendar transaction: `after` runs once the transaction has
 * finished, successfully or not. After a failure it still runs, because the
 * outcome of a failed COMMIT can be unknown and a pass is cheap.
 */
const afterEachWrite = (calendar: CalendarTransaction, after: () => void): CalendarTransaction =>
  async (work) => {
    try {
      return await calendar(work);
    } finally {
      after();
    }
  };

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
  notifications,
  overrides = {},
}: {
  config: AppConfig;
  logger: Logger;
  database: Database;
  isShuttingDown: () => boolean;
  notifications?: NotificationsRuntime | undefined;
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
  const catalog = createCatalogService({ prisma: database.prisma });
  api.use(
    "/services/:serviceId/availability",
    createPublicAvailabilityRouter({ prisma: database.prisma, catalog, rules, now }),
  );
  api.use("/services", createPublicCatalogRouter(catalog, now));

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

    // Booking writes wake the notification sender right after the
    // transaction; the HTTP response does not wait for any email.
    const bookings = createBookingService({
      prisma: database.prisma,
      calendar: notifications === undefined ? calendar : afterEachWrite(calendar, notifications.wake),
      rules,
      now,
    });
    const notificationStatus =
      notifications === undefined ? undefined : createNotificationStatusReader({ prisma: database.prisma, now });
    api.use("/bookings", authenticate, createClientBookingRouter({ bookings, guards, rules, now, notificationStatus }));

    // Administration lives in the owning modules; every route needs a
    // verified admin, checked on the server for each request.
    const admin = Router();
    admin.use(
      "/schedule",
      createAdminScheduleRouter({
        schedule: createScheduleService({ prisma: database.prisma, calendar, rules, now }),
        rules,
        now,
      }),
    );
    admin.use("/bookings", createAdminBookingRouter({ bookings, rules, now, notificationStatus }));
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
    apiDocs: config.apiDocs,
  });
};
