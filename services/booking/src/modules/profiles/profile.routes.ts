import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { UserProfile } from "../../generated/prisma/client.js";
import { requireIdentity } from "../../http/auth/authenticate.js";
import { describeError, type Logger } from "../../logging/logger.js";
import type { IdentityProvider, VerifiedIdentity } from "../auth/identity.js";
import { AppError } from "../../shared/errors/app-error.js";
import { withValidatedBody } from "../../shared/http/validated-body.js";
import {
  MARKETING_CONSENT_TEXT_VERSION,
  requireCurrentConsentText,
  toMarketingStatus,
  type MarketingStatus,
  type ConsentRequest,
} from "../marketing/consent.js";
import type { MarketingRepository } from "../marketing/marketing.repository.js";
import { consentTextVersionSchema, deliveryFailed, testRecipientNotAllowed } from "../marketing/marketing.routes.js";
import type { MarketingService, RequestOutcome, WelcomeEmail } from "../marketing/marketing.service.js";
import { updateOwnProfileSchema } from "./profile.schema.js";
import { toProfileView, type ProfileService } from "./profile.service.js";

export const syncSchema = z
  .object({
    // Sign-up checkbox (optional, unticked by default). Absent or false never
    // changes an existing subscription; true starts double opt-in at most once.
    marketingOptIn: z.boolean().optional(),
    marketingConsentTextVersion: consentTextVersionSchema.optional(),
  })
  .strict()
  .refine((body) => body.marketingOptIn !== true || body.marketingConsentTextVersion !== undefined, {
    message: "required when marketingOptIn is true",
    path: ["marketingConsentTextVersion"],
  })
  .optional();

export const ownSubscriptionSchema = z.object({ consentTextVersion: consentTextVersionSchema }).strict();

/**
 * Result of `marketingOptIn: true` in a sync. The profile sync itself
 * succeeded in every case.
 * - subscribed / already_subscribed: a verified, registered identity is
 *   subscribed at once (no confirmation link); welcomeEmail tells whether
 *   the "you are subscribed" email was accepted;
 * - unavailable: marketing is switched off, or the session has no email
 *   (guests use the public subscription form);
 * - consent_text_outdated: the client showed another text version;
 * - failed: unexpected server error (logged); nothing was promised.
 */
export type OptInOutcome =
  | RequestOutcome
  | "subscribed"
  | "already_subscribed"
  | "unavailable"
  | "consent_text_outdated"
  | "failed";

/**
 * /api/me: the caller's own profile. Every route requires a verified
 * Firebase ID token; there is no route that takes another user's id.
 */
export const createProfileRouter = ({
  authenticate,
  profiles,
  identityProvider,
  marketing,
  logger,
}: {
  authenticate: RequestHandler;
  profiles: ProfileService;
  identityProvider: IdentityProvider;
  marketing: { repository: MarketingRepository; service: MarketingService | undefined };
  logger: Logger;
}): Router => {
  const router = Router();
  router.use(authenticate);

  const marketingStatusOf = async (profile: UserProfile): Promise<MarketingStatus | null> => {
    if (profile.email === null || !profile.emailVerified) {
      return null;
    }
    return toMarketingStatus(await marketing.repository.findByEmail(profile.email));
  };

  const view = async (profile: UserProfile) =>
    toProfileView(profile, await marketingStatusOf(profile), marketing.service !== undefined);

  const optIn = async (
    identity: VerifiedIdentity,
    textVersion: string,
  ): Promise<{ outcome: OptInOutcome; welcomeEmail?: WelcomeEmail }> => {
    if (marketing.service === undefined || identity.isAnonymous || identity.email === undefined) {
      return { outcome: "unavailable" };
    }
    if (textVersion !== MARKETING_CONSENT_TEXT_VERSION) {
      return { outcome: "consent_text_outdated" };
    }
    const consent: ConsentRequest = { source: "signup_checkbox", textVersion };
    try {
      // email_verified from the verified Firebase token, never from the body.
      if (identity.emailVerified) {
        return await marketing.service.subscribeVerified(identity.email, consent, "signup");
      }
      return { outcome: await marketing.service.requestSubscription(identity.email, consent, "signup") };
    } catch (error) {
      logger.error({ error: describeError(error) }, "marketing opt-in during profile sync failed");
      return { outcome: "failed" };
    }
  };

  // Create or refresh the profile from the token. Call after sign-in, after
  // linking an anonymous session and after a forced token refresh.
  router.post(
    "/sync",
    withValidatedBody(syncSchema, async (body, res, _next, req) => {
      const identity = requireIdentity(req);
      const profile = await profiles.sync(identity);

      const result =
        body?.marketingOptIn === true && body.marketingConsentTextVersion !== undefined
          ? await optIn(identity, body.marketingConsentTextVersion)
          : undefined;

      res.status(200).json({
        ...(await view(profile)),
        ...(result !== undefined
          ? { marketingOptIn: { ...result, currentConsentTextVersion: MARKETING_CONSENT_TEXT_VERSION } }
          : {}),
      });
    }),
  );

  router.get("/", async (req, res) => {
    const profile = await profiles.getOwn(requireIdentity(req));
    res.status(200).json(await view(profile));
  });

  router.patch(
    "/",
    withValidatedBody(updateOwnProfileSchema, async (body, res, _next, req) => {
      const profile = await profiles.updateOwn(requireIdentity(req), body);
      res.status(200).json(await view(profile));
    }),
  );

  // Explicit (re-)subscription of the signed-in user's own address, also after
  // unsubscribing. Verified email (from the verified Firebase token): active
  // at once, 200, plus a "you are subscribed" email. Unverified: double opt-in,
  // 202, active only after the emailed link. There is no address in the body.
  router.post(
    "/marketing/subscription",
    withValidatedBody(ownSubscriptionSchema, async ({ consentTextVersion }, res, _next, req) => {
      const identity = requireIdentity(req);
      if (marketing.service === undefined) {
        throw new AppError(404, "Not found", { code: "NOT_FOUND" });
      }
      if (identity.isAnonymous || identity.email === undefined) {
        throw new AppError(403, "A registered account with an email is required; guests use the subscription form", {
          code: "REGISTERED_ACCOUNT_REQUIRED",
        });
      }
      const consent: ConsentRequest = { source: "account_request", textVersion: requireCurrentConsentText(consentTextVersion) };
      if (identity.emailVerified) {
        const direct = await marketing.service.subscribeVerified(identity.email, consent, "explicit");
        if (direct.outcome === "test_recipient_not_allowed") {
          throw testRecipientNotAllowed();
        }
        const status = toMarketingStatus(await marketing.repository.findByEmail(identity.email.trim().toLowerCase()));
        res.status(200).json({ ...direct, marketing: status });
        return;
      }
      const outcome = await marketing.service.requestSubscription(identity.email, consent, "explicit");
      if (outcome === "test_recipient_not_allowed") {
        throw testRecipientNotAllowed();
      }
      if (outcome === "delivery_failed") {
        throw await deliveryFailed(marketing.service, identity.email);
      }
      // A confirmation sent recently (lost or not yet read): tell the owner
      // when the "send again" button works.
      const retryAfterSeconds =
        outcome === "no_action" ? await marketing.service.resendAvailableInSeconds(identity.email) : 0;
      res.status(202).json(retryAfterSeconds > 0 ? { outcome, retryAfterSeconds } : { outcome });
    }),
  );

  // Unsubscribing never needs email delivery, so it works even when marketing
  // emails are switched off. Only for an email the user has proven to own.
  router.delete("/marketing/subscription", async (req, res) => {
    const profile = await profiles.sync(requireIdentity(req));
    if (profile.email === null || !profile.emailVerified) {
      throw new AppError(403, "Verify your email first", { code: "EMAIL_NOT_VERIFIED" });
    }
    const subscription = await marketing.repository.findByEmail(profile.email);
    if (subscription !== null) {
      await marketing.repository.unsubscribe(subscription.id, new Date());
    }
    res.status(200).json(await view(profile));
  });

  // Sign out everywhere: revokes refresh tokens; ID tokens issued before now
  // are rejected by the server from the next request on.
  router.post("/sessions/revoke", async (req, res) => {
    const outcome = await identityProvider.revokeAllSessions(requireIdentity(req).uid);
    if (outcome === "unavailable") {
      throw new AppError(503, "Authentication is temporarily unavailable; retry later", {
        code: "AUTH_UNAVAILABLE",
        details: { retryAfterSeconds: 5 },
      });
    }
    res.status(204).end();
  });

  return router;
};
