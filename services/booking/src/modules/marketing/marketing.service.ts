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

/**
 * How long an address may not get a new confirmation attempt after Brevo's
 * 429: the provider's Retry-After whenever it is a valid positive duration,
 * however long (never shortened: no attempt before the provider's time),
 * otherwise (absent, zero, unparseable) the usual cooldown.
 */
export const rateLimitBlockMs = (retryAfterMs: number | null): number =>
  retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : CONFIRMATION_COOLDOWN_MS;

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
 *   inside the cooldown sends nothing (no duplicate confirmation emails);
 * - test_recipient_not_allowed: a test environment with a recipient
 *   allowlist (MARKETING_RECIPIENT_ALLOWLIST) and the address is not on it:
 *   nothing was recorded or sent, and no success is claimed.
 */
export type RequestOutcome = "confirmation_sent" | "delivery_failed" | "no_action" | "test_recipient_not_allowed";

export type ConfirmResult = "subscribed" | "already_subscribed";

/** What happened to the "you are subscribed" email after a direct activation. */
export type WelcomeEmail = "sent" | "not_sent" | "unknown";

/**
 * Direct subscription of a verified, registered user's own address:
 * - subscribed: activated now (pending confirmation, if any, superseded);
 *   welcomeEmail tells whether the informational email was accepted;
 * - already_subscribed: it was active; nothing changed, no email;
 * - no_action: the sign-up checkbox after an earlier consent or unsubscribe
 *   (never re-subscribes on its own);
 * - test_recipient_not_allowed: outside the test allowlist; nothing changed.
 */
export type DirectOutcome =
  | { outcome: "subscribed"; welcomeEmail: WelcomeEmail }
  | { outcome: "already_subscribed" }
  | { outcome: "no_action" }
  | { outcome: "test_recipient_not_allowed" };

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
  recipientAllowlist = null,
  now = () => Date.now(),
}: {
  repository: MarketingRepository;
  mailer: MarketingMailer;
  tokens: ActionTokenService;
  frontendUrl: string;
  logger: Logger;
  /** Test environments only: marketing emails go to these addresses only (lowercase). null: no restriction. */
  recipientAllowlist?: ReadonlySet<string> | null;
  now?: () => number;
}) => {
  const allowed = (email: string): boolean => recipientAllowlist === null || recipientAllowlist.has(email.trim().toLowerCase());

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
    // Checked first: an address outside the test allowlist gets no row, no
    // claim, no provider call and no success.
    if (!allowed(email)) {
      logger.warn({ code: "recipient_not_allowed" }, "marketing email to an address outside the test allowlist refused");
      return "test_recipient_not_allowed";
    }
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

  /**
   * Activates the subscription at once. Only for the verified email of the
   * caller's own identity (checked by the route from the verified Firebase
   * token, never from the request body). The welcome email follows the
   * committed activation; its failure never undoes the subscription.
   */
  const subscribeVerified = async (email: string, consent: ConsentRequest, mode: RequestMode): Promise<DirectOutcome> => {
    const address = email.trim().toLowerCase();
    if (!allowed(address)) {
      logger.warn({ code: "recipient_not_allowed" }, "marketing email to an address outside the test allowlist refused");
      return { outcome: "test_recipient_not_allowed" };
    }
    const subscription = await repository.ensureExists(address);
    if (subscription.subscribed) {
      return { outcome: "already_subscribed" };
    }
    if (!(await repository.activate(subscription.id, { at: new Date(now()), mode, consent }))) {
      // Lost a concurrent race (now active) or the sign-up rule refused it.
      const current = await repository.findById(subscription.id);
      return current?.subscribed === true ? { outcome: "already_subscribed" } : { outcome: "no_action" };
    }

    // One key per activation: a repeat of this send is recognised by Brevo; a
    // later subscription after an unsubscribe is a new activation, a new key.
    const activation = randomBytes(16).toString("base64url");
    const unsubscribeUrl = link("/unsubscribe", tokens.createToken("marketing_unsubscribe", subscription.id));
    const sent = await mailer.sendSubscriptionConfirmed(
      subscription.email,
      unsubscribeUrl,
      idempotencyKeyFor("marketing_subscription_activated", subscription.id, activation),
    );
    if (sent.kind !== "accepted") {
      logger.error(
        { code: sent.kind === "rate_limited" ? "rate_limited" : sent.code },
        "subscription activated; welcome email not accepted",
      );
    }
    return {
      outcome: "subscribed",
      welcomeEmail: sent.kind === "accepted" ? "sent" : sent.kind === "uncertain" ? "unknown" : "not_sent",
    };
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
        // The subscription is active either way; outside the test allowlist
        // only its "confirmed" email is not sent (logged).
        if (!allowed(subscription.email)) {
          logger.warn({ code: "recipient_not_allowed" }, "subscription confirmed email skipped: address outside the test allowlist");
          return "subscribed";
        }
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
   * confirmationSentAt is read here as the anchor of the resend limit only
   * (after a 429 it can lie in the future and no email was sent).
   */
  const resendAvailableInSeconds = async (email: string): Promise<number> => {
    const subscription = await repository.findByEmail(email);
    if (subscription === null || subscription.subscribed || subscription.confirmationSentAt === null) {
      return 0;
    }
    const remaining = subscription.confirmationSentAt.getTime() + CONFIRMATION_COOLDOWN_MS - now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  };

  return { requestSubscription, subscribeVerified, confirm, unsubscribeByToken, resendAvailableInSeconds };
};
