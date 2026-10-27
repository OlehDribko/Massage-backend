import { Router } from "express";
import { z } from "zod";
import { withValidatedBody } from "../../shared/http/validated-body.js";
import { actionTokenSchema } from "../email/schema/email.schema.js";
import type { MarketingService } from "./marketing.service.js";

const subscribeSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  })
  .strict();

/**
 * /api/marketing: public (no account needed). Guests subscribe here too;
 * nothing here creates or changes a profile.
 */
export const createMarketingRouter = (service: MarketingService): Router => {
  const router = Router();

  router.post(
    "/subscriptions",
    withValidatedBody(subscribeSchema, async ({ email }, res) => {
      await service.requestSubscription(email);
      res.status(202).json({
        code: "SUBSCRIPTION_REQUESTED",
        message: "If this address can receive email, a confirmation link has been sent to it.",
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
      await service.unsubscribe(token);
      res.status(200).json({
        code: "UNSUBSCRIBED",
        message:
          "You will no longer receive marketing emails. Emails about your account and bookings are not affected.",
      });
    }),
  );

  return router;
};
