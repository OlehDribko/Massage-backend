import { BrevoClient, BrevoError, BrevoTimeoutError } from "@getbrevo/brevo";
import { z } from "zod";
import type { EmailProvider, SendOutcome } from "./provider.js";

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
 */
const errorBodySchema = z.object({ code: z.string().optional() }).passthrough();

const retryAfterMs = (error: BrevoError): number | null => {
  const header = error.rawResponse?.headers.get("retry-after") ?? null;
  if (header === null) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
};

/** Maps a failed Brevo call to an outcome; exported for unit tests. */
export const classifyBrevoError = (error: unknown): SendOutcome => {
  if (error instanceof BrevoTimeoutError) {
    return { kind: "retryable", code: "timeout", retryAfterMs: null };
  }
  if (!(error instanceof BrevoError) || error.statusCode === undefined) {
    return { kind: "retryable", code: "network", retryAfterMs: null };
  }
  const status = error.statusCode;
  const body = errorBodySchema.safeParse(error.body);
  const code = body.success ? body.data.code : undefined;

  if (status === 401) {
    return { kind: "configuration", code: "provider_auth" };
  }
  if (status === 403) {
    return { kind: "configuration", code: "provider_forbidden" };
  }
  if (status === 402) {
    return { kind: "configuration", code: "provider_account" };
  }
  if (status === 429) {
    return { kind: "retryable", code: "rate_limited", retryAfterMs: retryAfterMs(error) };
  }
  if (status >= 500 || status === 408) {
    return { kind: "retryable", code: "provider_unavailable", retryAfterMs: retryAfterMs(error) };
  }
  if (status === 400 && code === "duplicate_parameter") {
    return { kind: "duplicate" };
  }
  // Other 4xx: this message cannot be sent as is. Brevo's codes (e.g.
  // invalid_parameter) do not say which field; recipients are validated
  // before sending, so no recipient-specific code is guessed here.
  return { kind: "rejected", code: "provider_rejected" };
};

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
