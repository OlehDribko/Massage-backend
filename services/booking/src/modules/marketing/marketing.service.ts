import { randomBytes } from "node:crypto";
import { z } from "zod";
import { idempotencyKeyFor } from "../../integrations/brevo/idempotency.js";
import type { Logger } from "../../logging/logger.js";
import type { MarketingMailer } from "../email/service/email.service.js";
import {
  invalidActionToken,
  type ActionTokenService,
} from "../email/tokens/action-token.service.js";
import type { ConsentRequest } from "./consent.js";
import type { MarketingRepository, RequestMode } from "./marketing.repository.js";

/** One confirmation email per address per this interval (explicit requests). */
export const CONFIRMATION_COOLDOWN_MS = 10 * 60 * 1000;

/** A Retry-After above this is not plausible for an email API and is not used. */
export const MAX_RATE_LIMIT_BLOCK_MS = 24 * 60 * 60 * 1000;

/**
 * How long an address may not get a new confirmation attempt after Brevo's
 * 429: the provider's Retry-After when valid (positive, at most 24 h),
 * otherwise the usual cooldown.
 */
export const rateLimitBlockMs = (retryAfterMs: number | null): number =>
  retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs > 0 && retryAfterMs <= MAX_RATE_LIMIT_BLOCK_MS
    ? retryAfterMs
    : CONFIRMATION_COOLDOWN_MS;

const uuidSchema = z.uuid();

/**
 * - confirmation_sent: a confirmation email was accepted by the provider
 *   (not a promise of delivery to the inbox);
 * - delivery_failed: the provider certainly did not accept the email.
 *   Rejected or configuration: nothing changed, the request can be repeated.
 *   Rate limit (429): no email and no pending confirmation, but new attempts
 *   for this address are blocked until Retry-After (or the cooldown) ends;
 *   repeats before that answer no_action without calling the provider;
 * - no_action: nothing to do (already subscribed, confirmation already sent
 *   recently, or the sign-up checkbox after an earlier unsubscribe). Not
 *   distinguished, so the answer reveals nothing about the address. Also
 *   when the outcome of sending is unknown (timeout, network, 5xx): the email
 *   may have been accepted, so the claim and its cooldown stay and a repeat
 *   inside the cooldown sends nothing (no duplicate confirmation emails).
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
    // One key per claim (subscription + nonce): a repeat of this operation is
    // recognised by Brevo; a later legitimate request (after the cooldown or
    // a new subscription after an unsubscribe) has a new nonce and a new key.
    const outcome = await mailer.sendConfirmationRequest(
      subscription.email,
      confirmUrl,
      idempotencyKeyFor("marketing_confirmation_request", subscription.id, nonce),
    );
    switch (outcome.kind) {
      case "accepted":
        return "confirmation_sent";
      case "not_sent":
        await repository.releaseConfirmation(subscription.id, nonce);
        logger.error({ code: outcome.code }, "marketing confirmation email not sent");
        return "delivery_failed";
      case "rate_limited": {
        // Keep the resend limit: the cooldown check then blocks every request
        // (and every new claim) until sentAt + blockMs, without the provider.
        const blockMs = rateLimitBlockMs(outcome.retryAfterMs);
        await repository.throttleConfirmation(subscription.id, nonce, new Date(sentAt + blockMs - CONFIRMATION_COOLDOWN_MS));
        logger.error({ code: "rate_limited", blockMs }, "marketing confirmation email refused by rate limit; resend blocked");
        return "delivery_failed";
      }
      case "uncertain":
        logger.warn({ code: outcome.code }, "marketing confirmation email outcome unknown; cooldown kept");
        return "no_action";
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
        // Sent once per successful confirmation (repository.confirm is true
        // only once per nonce); the key ties it to that confirmation.
        const outcome = await mailer.sendSubscriptionConfirmed(
          subscription.email,
          unsubscribeUrl,
          idempotencyKeyFor("marketing_subscription_confirmed", subscription.id, nonce),
        );
        if (outcome.kind !== "accepted") {
          logger.error(
            { code: outcome.kind === "rate_limited" ? "rate_limited" : outcome.code },
            "subscription confirmed email not accepted",
          );
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

  /**
   * Seconds until an explicit request may send a new confirmation email for
   * this address (0 when it may send now or there is nothing pending). Only
   * for the owner of the address: the public form stays neutral.
   */
  const resendAvailableInSeconds = async (email: string): Promise<number> => {
    const subscription = await repository.findByEmail(email);
    if (subscription === null || subscription.subscribed || subscription.confirmationSentAt === null) {
      return 0;
    }
    const remaining = subscription.confirmationSentAt.getTime() + CONFIRMATION_COOLDOWN_MS - now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  };

  return { requestSubscription, confirm, unsubscribeByToken, resendAvailableInSeconds };
};
