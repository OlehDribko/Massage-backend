import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../shared/errors/app-error.js";
import { withValidatedBody } from "../../shared/http/validated-body.js";
import { actionTokenSchema } from "../email/schema/email.schema.js";
import { requireCurrentConsentText } from "./consent.js";
import type { MarketingService } from "./marketing.service.js";

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const consentTextVersionSchema = z.string().min(1).max(64);

export const subscribeSchema = z
  .object({
    email: emailSchema,
    consentTextVersion: consentTextVersionSchema,
  })
  .strict();

/** Retry hint when nothing blocks a new attempt (rejected or configuration error: the claim was released). */
export const DELIVERY_FAILED_RETRY_SECONDS = 60;

/**
 * 503 after a confirmation email the provider certainly did not accept. The
 * hint is the resend block still stored for the address (after a provider
 * rate limit: until its Retry-After or the cooldown), read with the same
 * resendAvailableInSeconds the owner's "send again" uses; without a block,
 * DELIVERY_FAILED_RETRY_SECONDS. Message, body and the Retry-After header
 * (set by the error handler from retryAfterSeconds) carry the same value.
 */
export const deliveryFailed = async (service: MarketingService, email: string): Promise<AppError> => {
  const blocked = await service.resendAvailableInSeconds(email);
  const seconds = blocked > 0 ? blocked : DELIVERY_FAILED_RETRY_SECONDS;
  return new AppError(503, `The confirmation email could not be sent; retry in ${String(seconds)} seconds`, {
    code: "CONFIRMATION_EMAIL_NOT_SENT",
    details: { retryAfterSeconds: seconds },
  });
};

/**
 * /api/marketing: public (no account needed). Guests subscribe here too;
 * nothing here creates or changes a profile.
 */
export const createMarketingRouter = (service: MarketingService): Router => {
  const router = Router();

  router.post(
    "/subscriptions",
    withValidatedBody(subscribeSchema, async ({ email, consentTextVersion }, res) => {
      const outcome = await service.requestSubscription(
        email,
        { source: "subscription_form", textVersion: requireCurrentConsentText(consentTextVersion) },
        "explicit",
      );
      if (outcome === "delivery_failed") {
        throw await deliveryFailed(service, email);
      }
      // Same answer for new, pending, cooling-down and subscribed addresses.
      res.status(202).json({
        code: "SUBSCRIPTION_REQUESTED",
        message: "If this address can receive email and is not subscribed yet, a confirmation link has been sent to it.",
      });
    }),
  );

  router.post(
    "/subscriptions/confirm",
    withValidatedBody(actionTokenSchema, async ({ token }, res) => {
      const result = await service.confirm(token);
      res.status(200).json({
        code: result === "subscribed" ? "SUBSCRIBED" : "ALREADY_SUBSCRIBED",
        message: "Subscription to offers confirmed.",
      });
    }),
  );

  router.post(
    "/subscriptions/unsubscribe",
    withValidatedBody(actionTokenSchema, async ({ token }, res) => {
      await service.unsubscribeByToken(token);
      res.status(200).json({
        code: "UNSUBSCRIBED",
        message:
          "You will no longer receive marketing emails. Emails about your account and bookings are not affected.",
      });
    }),
  );

  return router;
};
