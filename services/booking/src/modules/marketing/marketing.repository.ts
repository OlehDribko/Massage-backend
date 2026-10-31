import type { MarketingSubscription, PrismaClient } from "../../generated/prisma/client.js";
import type { ConsentRequest } from "./consent.js";

/**
 * - "explicit": a new, deliberate action by the person (subscription form,
 *   re-subscribe button). Allowed after an unsubscribe.
 * - "signup": the sign-up checkbox, which may reach the server repeatedly
 *   (retries, every profile sync). Acts at most once per address: never after
 *   an unsubscribe, an earlier consent or an earlier confirmation email.
 */
export type RequestMode = "explicit" | "signup";

export type ConfirmationClaim = {
  nonce: string;
  sentAt: Date;
  /** Explicit requests: no new email if one was sent after this time. */
  cooldownSince: Date;
  mode: RequestMode;
  consent: ConsentRequest;
};

export type MarketingRepository = {
  /** Creates an unsubscribed row for the address if none exists (race-safe). */
  ensureExists: (email: string) => Promise<MarketingSubscription>;
  findByEmail: (email: string) => Promise<MarketingSubscription | null>;
  findById: (id: string) => Promise<MarketingSubscription | null>;
  /**
   * Records a confirmation request with a fresh nonce if the rules of the
   * mode allow it. Atomic: of concurrent requests at most one wins.
   */
  claimConfirmation: (id: string, claim: ConfirmationClaim) => Promise<boolean>;
  /** Undoes a claim whose email could not be sent, so the request can be retried. */
  releaseConfirmation: (id: string, nonce: string) => Promise<void>;
  /**
   * The provider refused the email for rate limiting (429): no email exists,
   * so the pending confirmation is cleared (no link to confirm), but the
   * resend limit stays: confirmationSentAt is set to `cooldownAnchor`, so the
   * usual cooldown check blocks new requests until anchor + cooldown.
   */
  throttleConfirmation: (id: string, nonce: string, cooldownAnchor: Date) => Promise<void>;
  /** Subscribes if the nonce is the current one, recording the consent. */
  confirm: (id: string, nonce: string, at: Date) => Promise<boolean>;
  /** Idempotent; also cancels an outstanding confirmation. */
  unsubscribe: (id: string, at: Date) => Promise<void>;
};

const clearedConfirmation = {
  confirmationNonce: null,
  confirmationSentAt: null,
  confirmationSource: null,
  confirmationTextVersion: null,
};

export const createMarketingRepository = (prisma: PrismaClient): MarketingRepository => ({
  ensureExists: async (email) => {
    await prisma.marketingSubscription.createMany({ data: [{ email }], skipDuplicates: true });
    return prisma.marketingSubscription.findUniqueOrThrow({ where: { email } });
  },

  findByEmail: (email) => prisma.marketingSubscription.findUnique({ where: { email } }),

  findById: (id) => prisma.marketingSubscription.findUnique({ where: { id } }),

  claimConfirmation: async (id, claim) => {
    // Sign-up: once per address, unless the only earlier attempt was refused
    // by the provider's rate limit (no nonce left) and its block has ended.
    const allowed =
      claim.mode === "signup"
        ? {
            unsubscribedAt: null,
            consentGivenAt: null,
            OR: [
              { confirmationSentAt: null },
              { confirmationNonce: null, confirmationSentAt: { lt: claim.cooldownSince } },
            ],
          }
        : {
            OR: [{ confirmationSentAt: null }, { confirmationSentAt: { lt: claim.cooldownSince } }],
          };
    const result = await prisma.marketingSubscription.updateMany({
      where: { id, subscribed: false, ...allowed },
      data: {
        confirmationNonce: claim.nonce,
        confirmationSentAt: claim.sentAt,
        confirmationSource: claim.consent.source,
        confirmationTextVersion: claim.consent.textVersion,
      },
    });
    return result.count === 1;
  },

  releaseConfirmation: async (id, nonce) => {
    await prisma.marketingSubscription.updateMany({
      where: { id, confirmationNonce: nonce },
      data: clearedConfirmation,
    });
  },

  throttleConfirmation: async (id, nonce, cooldownAnchor) => {
    await prisma.marketingSubscription.updateMany({
      where: { id, confirmationNonce: nonce },
      data: { ...clearedConfirmation, confirmationSentAt: cooldownAnchor },
    });
  },

  confirm: async (id, nonce, at) => {
    const row = await prisma.marketingSubscription.findUnique({ where: { id } });
    if (
      row === null ||
      row.subscribed ||
      row.confirmationNonce !== nonce ||
      row.confirmationSource === null ||
      row.confirmationTextVersion === null
    ) {
      return false;
    }
    // Conditional on the same nonce: the request read above is the one confirmed.
    const result = await prisma.marketingSubscription.updateMany({
      where: { id, subscribed: false, confirmationNonce: nonce },
      data: {
        subscribed: true,
        consentGivenAt: at,
        consentSource: row.confirmationSource,
        consentTextVersion: row.confirmationTextVersion,
        unsubscribedAt: null,
        ...clearedConfirmation,
      },
    });
    return result.count === 1;
  },

  unsubscribe: async (id, at) => {
    await prisma.marketingSubscription.updateMany({
      where: { id, OR: [{ subscribed: true }, { confirmationNonce: { not: null } }] },
      data: { subscribed: false, unsubscribedAt: at, ...clearedConfirmation },
    });
  },
});
