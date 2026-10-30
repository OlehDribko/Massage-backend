/**
 * Replaceable email provider. The worker depends only on this interface;
 * Brevo is one implementation (brevo-provider.ts), tests use a fake.
 */
export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * Stable per delivery (its UUID), the same on every attempt, so the
   * provider can drop a repeat it has already accepted.
   */
  idempotencyKey: string;
  /** Non-personal tags for the provider's dashboard, e.g. "booking.created". */
  tags: string[];
};

/**
 * What one provider call means for the delivery. Codes are fixed and safe to
 * store and log (never provider text).
 */
export type SendOutcome =
  /** Accepted for sending. Not "delivered to the mailbox". */
  | { kind: "accepted"; providerMessageId: string | null }
  /** The provider reports this idempotency key as already processed: accepted by an earlier attempt. */
  | { kind: "duplicate" }
  /** Permanent for this message: retrying the same message cannot succeed. */
  | { kind: "rejected"; code: "provider_rejected" }
  /** Temporary: retry later (retryAfterMs from Retry-After, when given). */
  | {
      kind: "retryable";
      code: "rate_limited" | "provider_unavailable" | "timeout" | "network";
      retryAfterMs: number | null;
    }
  /**
   * Provider-wide problem (wrong key, missing permission, account issue):
   * not this message's fault. The worker pauses and keeps the message pending.
   */
  | { kind: "configuration"; code: "provider_auth" | "provider_forbidden" | "provider_account" };

export type EmailProvider = {
  /** Never throws for provider errors; returns an outcome. */
  send: (email: OutgoingEmail) => Promise<SendOutcome>;
};
