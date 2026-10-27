import type { MarketingSubscription, PrismaClient } from "../../generated/prisma/client.js";

export type MarketingRepository = {
  /** Creates a pending row for the address if none exists (race-safe). */
  ensureExists: (email: string) => Promise<MarketingSubscription>;
  /**
   * Records a confirmation send with a fresh nonce unless the address is
   * already subscribed or a link was sent after `cooldownSince`.
   * Atomic: of concurrent requests at most one wins.
   */
  claimConfirmationSend: (id: string, nonce: string, sentAt: Date, cooldownSince: Date) => Promise<boolean>;
  /** Undoes a claim whose email could not be sent, so the user can retry. */
  releaseConfirmationClaim: (id: string, nonce: string) => Promise<void>;
  /** Subscribes if the nonce is the current one; the nonce is used up. */
  confirm: (id: string, nonce: string) => Promise<boolean>;
  findById: (id: string) => Promise<MarketingSubscription | null>;
  /** Idempotent; also invalidates any outstanding confirmation link. */
  unsubscribe: (id: string) => Promise<void>;
};

export const createMarketingRepository = (prisma: PrismaClient): MarketingRepository => ({
  ensureExists: async (email) => {
    await prisma.marketingSubscription.createMany({ data: [{ email }], skipDuplicates: true });
    return prisma.marketingSubscription.findUniqueOrThrow({ where: { email } });
  },

  claimConfirmationSend: async (id, nonce, sentAt, cooldownSince) => {
    const result = await prisma.marketingSubscription.updateMany({
      where: {
        id,
        status: { not: "subscribed" },
        OR: [{ confirmationSentAt: null }, { confirmationSentAt: { lt: cooldownSince } }],
      },
      data: { confirmationNonce: nonce, confirmationSentAt: sentAt },
    });
    return result.count === 1;
  },

  releaseConfirmationClaim: async (id, nonce) => {
    await prisma.marketingSubscription.updateMany({
      where: { id, confirmationNonce: nonce },
      data: { confirmationNonce: null, confirmationSentAt: null },
    });
  },

  confirm: async (id, nonce) => {
    const result = await prisma.marketingSubscription.updateMany({
      where: { id, confirmationNonce: nonce, status: { not: "subscribed" } },
      data: {
        status: "subscribed",
        subscribedAt: new Date(),
        unsubscribedAt: null,
        confirmationNonce: null,
      },
    });
    return result.count === 1;
  },

  findById: (id) => prisma.marketingSubscription.findUnique({ where: { id } }),

  unsubscribe: async (id) => {
    await prisma.marketingSubscription.updateMany({
      where: { id, status: { not: "unsubscribed" } },
      data: { status: "unsubscribed", unsubscribedAt: new Date(), confirmationNonce: null },
    });
  },
});
