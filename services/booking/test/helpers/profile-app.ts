import { Router } from "express";
import { createApp } from "../../src/app.js";
import { createAuthenticate } from "../../src/http/auth/authenticate.js";
import { createAccessGuards, requireActor } from "../../src/modules/access/require-access.js";
import { createProfileRouter } from "../../src/modules/profiles/profile.routes.js";
import { createProfileService } from "../../src/modules/profiles/profile.service.js";
import { createFakeIdentityProvider } from "./fake-identity.js";
import {
  createInMemoryMarketingRepository,
  createInMemoryProfileRepository,
} from "./in-memory-repositories.js";
import { createActionTokenService } from "../../src/modules/email/tokens/action-token.service.js";
import type { MarketingMailer } from "../../src/modules/email/service/email.service.js";
import { createMarketingService } from "../../src/modules/marketing/marketing.service.js";
import { createCapturingLogger } from "./logs.js";

/**
 * App with /api/me and two sample routes guarded like future business
 * routes (/api/test/booking, /api/test/admin).
 */
export type SentMail = { kind: "confirm" | "confirmed"; email: string; url: string };

export const createProfileTestApp = (
  options: { marketingEnabled?: boolean; failMarketingSends?: boolean } = {},
) => {
  const identities = createFakeIdentityProvider();
  const profiles = createInMemoryProfileRepository();
  const marketingRows = createInMemoryMarketingRepository();
  const logs = createCapturingLogger();
  const sent: SentMail[] = [];
  const mail = { failing: options.failMarketingSends === true };
  let clock = Date.parse("2026-10-28T12:00:00Z");
  const mailer: MarketingMailer = {
    sendConfirmationRequest: (email, url) => {
      if (mail.failing) {
        return Promise.resolve({ kind: "not_sent", code: "provider_rejected" });
      }
      sent.push({ kind: "confirm", email, url });
      return Promise.resolve({ kind: "accepted" });
    },
    sendSubscriptionConfirmed: (email, url) => {
      sent.push({ kind: "confirmed", email, url });
      return Promise.resolve({ kind: "accepted" });
    },
  };
  const marketingService =
    options.marketingEnabled === false
      ? undefined
      : createMarketingService({
          repository: marketingRows.repository,
          mailer,
          tokens: createActionTokenService("profile-test-secret-0123456789abcdef"),
          frontendUrl: "https://front.example.invalid",
          logger: logs.logger,
          now: () => clock,
        });
  const service = createProfileService(profiles.repository);
  const authenticate = createAuthenticate(identities.provider);
  const guards = createAccessGuards(service);

  const guarded = Router();
  guarded.use(authenticate);
  guarded.post("/booking", guards.requireBookingClient, (req, res) => {
    res.status(200).json({ actorId: requireActor(req).id });
  });
  guarded.post("/admin", guards.requireAdmin, (req, res) => {
    res.status(200).json({ actorId: requireActor(req).id });
  });

  const api = Router();
  api.use(
    "/me",
    createProfileRouter({
      authenticate,
      profiles: service,
      identityProvider: identities.provider,
      marketing: { repository: marketingRows.repository, service: marketingService },
      logger: logs.logger,
    }),
  );
  api.use("/test", guarded);

  const app = createApp({
    logger: logs.logger,
    isShuttingDown: () => false,
    probeReadiness: () => Promise.resolve("ready"),
    appVersion: undefined,
    corsOrigin: undefined,
    apiRouter: api,
  });

  return {
    app,
    identities,
    profiles,
    marketing: marketingRows,
    marketingService,
    sent,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
    setMarketingSendsFailing: (failing: boolean) => {
      mail.failing = failing;
    },
  };
};
