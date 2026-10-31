import { BrevoError, BrevoTimeoutError } from "@getbrevo/brevo";
import { z } from "zod";

/**
 * What a failed Brevo call means, shared by every module that sends email
 * through Brevo (notifications, marketing). Codes are fixed and safe to store
 * and log (never provider text). Each module decides what to do with them.
 */
export type BrevoFailure =
  /** The provider reports this idempotency key as already processed: an earlier attempt was accepted. */
  | { kind: "duplicate" }
  /** Permanent for this message: retrying the same message cannot succeed. */
  | { kind: "rejected"; code: "provider_rejected" }
  /**
   * Temporary. `rate_limited` (429): the request was refused and not
   * processed. `provider_unavailable` (5xx, 408), `timeout`, `network`: the
   * outcome is unknown, the provider may have accepted the email.
   */
  | {
      kind: "retryable";
      code: "rate_limited" | "provider_unavailable" | "timeout" | "network";
      retryAfterMs: number | null;
    }
  /** Provider-wide problem (wrong key, missing permission, account issue). */
  | { kind: "configuration"; code: "provider_auth" | "provider_forbidden" | "provider_account" };

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

/** Maps a failed Brevo SDK call to a fixed outcome. */
export const classifyBrevoError = (error: unknown): BrevoFailure => {
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
  // invalid_parameter) do not say which field; no recipient-specific code is
  // guessed here.
  return { kind: "rejected", code: "provider_rejected" };
};
