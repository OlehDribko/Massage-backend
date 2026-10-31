import type { BrevoFailure } from "../integrations/brevo/brevo-errors.js";

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
 * What one provider call means for the delivery: accepted, or one of the
 * shared failure outcomes (integrations/brevo/brevo-errors.ts). Codes are
 * fixed and safe to store and log (never provider text).
 * - accepted: accepted for sending, not "delivered to the mailbox";
 * - configuration (wrong key, permission, account): a retry in minutes would
 *   not help, the delivery fails at once with this code.
 */
export type SendOutcome = { kind: "accepted"; providerMessageId: string | null } | BrevoFailure;

export type EmailProvider = {
  /** Never throws for provider errors; returns an outcome. */
  send: (email: OutgoingEmail) => Promise<SendOutcome>;
};
