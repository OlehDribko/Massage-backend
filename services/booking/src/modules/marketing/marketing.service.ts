import { randomBytes } from "node:crypto";
import { z } from "zod";
import { describeError, type Logger } from "../../logging/logger.js";
import type { MarketingMailer } from "../email/service/email.service.js";
import {
  invalidActionToken,
  type ActionTokenService,
} from "../email/tokens/action-token.service.js";
import type { MarketingRepository } from "./marketing.repository.js";

/** One confirmation email per address per this interval. */
export const CONFIRMATION_COOLDOWN_MS = 10 * 60 * 1000;

const uuidSchema = z.uuid();

export type ConfirmResult = "subscribed" | "already_subscribed";

export type MarketingService = ReturnType<typeof createMarketingService>;

/**
 * Marketing consent, independent of accounts and profiles:
 * - subscribing never creates or verifies an account, and is never automatic;
 * - consent starts only after the emailed link is confirmed (double opt-in);
 * - unsubscribing affects marketing only, never service emails;
 * - responses do not reveal whether an address is known or subscribed.
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

  const requestSubscription = async (email: string): Promise<void> => {
    const subscription = await repository.ensureExists(email);
    if (subscription.status === "subscribed") {
      return;
    }

    const nonce = randomBytes(16).toString("base64url");
    const sentAt = now();
    const claimed = await repository.claimConfirmationSend(
      subscription.id,
      nonce,
      new Date(sentAt),
      new Date(sentAt - CONFIRMATION_COOLDOWN_MS),
    );
    if (!claimed) {
      return;
    }

    const confirmUrl = link(
      "/marketing/confirm",
      tokens.createToken("marketing_confirm", subscription.id, nonce),
    );
    try {
      await mailer.sendConfirmationRequest(subscription.email, confirmUrl);
    } catch (error) {
      await repository.releaseConfirmationClaim(subscription.id, nonce);
      logger.error({ error: describeError(error) }, "failed to send marketing confirmation email");
    }
  };

  const subjectOf = (token: string, purpose: "marketing_confirm" | "marketing_unsubscribe") => {
    const claims = tokens.verifyToken(token, purpose);
    if (!uuidSchema.safeParse(claims.subjectId).success) {
      throw invalidActionToken();
    }
    return claims;
  };

  const confirm = async (token: string): Promise<ConfirmResult> => {
    const { subjectId, nonce } = subjectOf(token, "marketing_confirm");
    if (nonce === undefined) {
      throw invalidActionToken();
    }

    if (await repository.confirm(subjectId, nonce)) {
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
    if (current?.status === "subscribed") {
      return "already_subscribed";
    }
    throw invalidActionToken();
  };

  // Same answer whether or not the subscription exists.
  const unsubscribe = async (token: string): Promise<void> => {
    const { subjectId } = subjectOf(token, "marketing_unsubscribe");
    await repository.unsubscribe(subjectId);
  };

  return { requestSubscription, confirm, unsubscribe };
};
