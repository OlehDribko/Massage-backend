import { BrevoClient } from "@getbrevo/brevo";
import { classifyBrevoError } from "../integrations/brevo/brevo-errors.js";
import type { EmailProvider } from "./provider.js";

/**
 * Brevo transactional email (POST /v3/smtp/email) behind EmailProvider.
 *
 * Idempotency (checked against Brevo's documentation, 2026-10-31):
 * `headers.idempotencyKey` (a UUID) in the request body; within its TTL
 * (30 minutes per the current docs; the 2021 changelog said 15) a repeat with
 * the same key is not sent again and is answered with the error code
 * `duplicate_parameter`. The delivery id is used as the key, so every attempt
 * of one delivery carries the same key. After the TTL, a repeat would be
 * sent again; see docs/notifications.md for the remaining risk.
 *
 * The SDK's own retries are off (maxRetries 0): the worker owns retries,
 * backoff and the lease, and the request timeout is shorter than the lease.
 * Error classification is shared with marketing (integrations/brevo).
 */
export const createBrevoProvider = ({
  apiKey,
  senderName,
  senderEmail,
  requestTimeoutMs,
  fetchImpl,
}: {
  apiKey: string;
  senderName: string;
  senderEmail: string;
  requestTimeoutMs: number;
  /** Tests only: a fake transport (no network, no real email). */
  fetchImpl?: typeof fetch;
}): EmailProvider => {
  const client = new BrevoClient({
    apiKey,
    timeoutInSeconds: requestTimeoutMs / 1000,
    maxRetries: 0,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });

  return {
    send: async (email) => {
      try {
        const response = await client.transactionalEmails.sendTransacEmail({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: email.to }],
          subject: email.subject,
          htmlContent: email.html,
          textContent: email.text,
          headers: { idempotencyKey: email.idempotencyKey },
          tags: email.tags,
        });
        return { kind: "accepted", providerMessageId: response.messageId ?? null };
      } catch (error) {
        return classifyBrevoError(error);
      }
    },
  };
};
