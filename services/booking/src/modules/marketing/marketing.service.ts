import { randomBytes } from "node:crypto";
import { z } from "zod";
import { describeError, type Logger } from "../../logging/logger.js";
import type { MarketingMailer } from "../email/service/email.service.js";
import {
  invalidActionToken,
  type ActionTokenService,
} from "../email/tokens/action-token.service.js";
import type { ConsentRequest } from "./consent.js";
import type { MarketingRepository, RequestMode } from "./marketing.repository.js";

/** One confirmation email per address per this interval (explicit requests). */
export const CONFIRMATION_COOLDOWN_MS = 10 * 60 * 1000;

const uuidSchema = z.uuid();

/**
 * - confirmation_sent: a confirmation email was accepted by the provider
 *   (not a promise of delivery to the inbox);
 * - delivery_failed: the email could not be handed to the provider; nothing
 *   changed, the request can be repeated;
 * - no_action: nothing to do (already subscribed, confirmation already sent
 *   recently, or the sign-up checkbox after an earlier unsubscribe). Not
 *   distinguished, so the answer reveals nothing about the address.
 */
export type RequestOutcome = "confirmation_sent" | "delivery_failed" | "no_action";

export type ConfirmResult = "subscribed" | "already_subscribed";

export type MarketingService = ReturnType<typeof createMarketingService>;

/**
 * Marketing consent, independent of accounts and profiles:
 * - consent starts only after the emailed link is confirmed (double opt-in);
 *   Firebase email verification is a different action and never counts;
 * - unsubscribing affects marketing only, never service emails;
 * - only an explicit request can start over after an unsubscribe.
 */
export const createMarketingService = ({
  repository,
  mailer,
  tokens,
  frontendUrl,
  logger,
  now = () => Date.now(),
}: {
  repository: MarketingRepository;
  mailer: MarketingMailer;
  tokens: ActionTokenService;
  frontendUrl: string;
  logger: Logger;
  now?: () => number;
}) => {
  const link = (path: "/marketing/confirm" | "/unsubscribe", token: string): string => {
    const url = new URL(path, frontendUrl);
    url.searchParams.set("token", token);
    return url.toString();
  };

  const requestSubscription = async (
    email: string,
    consent: ConsentRequest,
    mode: RequestMode,
  ): Promise<RequestOutcome> => {
    const subscription = await repository.ensureExists(email);
    if (subscription.subscribed) {
      return "no_action";
    }

    const nonce = randomBytes(16).toString("base64url");
    const sentAt = now();
    const claimed = await repository.claimConfirmation(subscription.id, {
      nonce,
      sentAt: new Date(sentAt),
      cooldownSince: new Date(sentAt - CONFIRMATION_COOLDOWN_MS),
      mode,
      consent,
    });
    if (!claimed) {
      return "no_action";
    }

    const confirmUrl = link(
      "/marketing/confirm",
      tokens.createToken("marketing_confirm", subscription.id, nonce),
    );
    try {
      await mailer.sendConfirmationRequest(subscription.email, confirmUrl);
      return "confirmation_sent";
    } catch (error) {
      await repository.releaseConfirmation(subscription.id, nonce);
      logger.error({ error: describeError(error) }, "failed to send marketing confirmation email");
      return "delivery_failed";
    }
  };

  const claimsOf = (token: string, purpose: "marketing_confirm" | "marketing_unsubscribe") => {
    const claims = tokens.verifyToken(token, purpose);
    if (!uuidSchema.safeParse(claims.subjectId).success) {
      throw invalidActionToken();
    }
    return claims;
  };

  const confirm = async (token: string): Promise<ConfirmResult> => {
    const { subjectId, nonce } = claimsOf(token, "marketing_confirm");
    if (nonce === undefined) {
      throw invalidActionToken();
    }

    if (await repository.confirm(subjectId, nonce, new Date(now()))) {
      const subscription = await repository.findById(subjectId);
      if (subscription !== null) {
        const unsubscribeUrl = link(
          "/unsubscribe",
          tokens.createToken("marketing_unsubscribe", subscription.id),
        );
        try {
          await mailer.sendSubscriptionConfirmed(subscription.email, unsubscribeUrl);
        } catch (error) {
          logger.error({ error: describeError(error) }, "failed to send subscription confirmed email");
        }
      }
      return "subscribed";
    }

    // A used, superseded or post-unsubscribe link must not (re)subscribe.
    const current = await repository.findById(subjectId);
    if (current?.subscribed === true) {
      return "already_subscribed";
    }
    throw invalidActionToken();
  };

  // Same answer whether or not the subscription exists.
  const unsubscribeByToken = async (token: string): Promise<void> => {
    const { subjectId } = claimsOf(token, "marketing_unsubscribe");
    await repository.unsubscribe(subjectId, new Date(now()));
  };

  return { requestSubscription, confirm, unsubscribeByToken };
};
