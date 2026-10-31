import { BrevoClient } from "@getbrevo/brevo";
import { classifyBrevoError } from "../../../integrations/brevo/brevo-errors.js";
import { emailTemplates } from "../templates/email.templates.js";
import type { SendTransactionalEmailType } from "../types/email.types.js";

export type EmailServiceConfig = {
  brevoApiKey: string;
  fromName: string;
  fromEmail: string;
  /** Tests only: a fake transport (no network, no real email). */
  fetchImpl?: typeof fetch;
};

/**
 * Result of one marketing email, sent inside an HTTP request:
 * - accepted: accepted by Brevo for sending (also when Brevo recognises the
 *   idempotency key of an earlier accepted attempt); not "delivered";
 * - not_sent: certainly not accepted (rejected, configuration, 429 rate limit:
 *   the request was refused and not processed); safe to try again;
 * - uncertain: timeout, network error or 5xx: Brevo may have accepted it.
 */
export type MailOutcome =
  | { kind: "accepted" }
  | { kind: "not_sent"; code: "provider_rejected" | "provider_auth" | "provider_forbidden" | "provider_account" | "rate_limited" }
  | { kind: "uncertain"; code: "provider_unavailable" | "timeout" | "network" };

/** Marketing emails; links and idempotency keys are built by the caller. */
export type MarketingMailer = {
  sendConfirmationRequest: (email: string, confirmUrl: string, idempotencyKey: string) => Promise<MailOutcome>;
  sendSubscriptionConfirmed: (email: string, unsubscribeUrl: string, idempotencyKey: string) => Promise<MailOutcome>;
};

/**
 * Limit of one Brevo call. It bounds only this call, not the whole HTTP
 * request (database, Firebase and the network to the client add to it).
 */
export const MARKETING_BREVO_TIMEOUT_MS = 10_000;

/**
 * Brevo transactional API. Created only when marketing is enabled.
 * No SDK retries (maxRetries 0): a retry inside the HTTP request would make it
 * long and could send a second email; repeats are decided by the caller.
 */
export const createBrevoMarketingMailer = ({
  brevoApiKey,
  fromName,
  fromEmail,
  fetchImpl,
}: EmailServiceConfig): MarketingMailer => {
  const brevo = new BrevoClient({
    apiKey: brevoApiKey,
    timeoutInSeconds: MARKETING_BREVO_TIMEOUT_MS / 1000,
    maxRetries: 0,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });

  const send = async (
    { to, subject, htmlContent }: SendTransactionalEmailType,
    idempotencyKey: string,
  ): Promise<MailOutcome> => {
    try {
      await brevo.transactionalEmails.sendTransacEmail({
        subject,
        htmlContent,
        sender: { name: fromName, email: fromEmail },
        to,
        headers: { idempotencyKey },
      });
      return { kind: "accepted" };
    } catch (error) {
      const failure = classifyBrevoError(error);
      switch (failure.kind) {
        case "duplicate":
          return { kind: "accepted" };
        case "rejected":
        case "configuration":
          return { kind: "not_sent", code: failure.code };
        case "retryable":
          return failure.code === "rate_limited"
            ? { kind: "not_sent", code: "rate_limited" }
            : { kind: "uncertain", code: failure.code };
      }
    }
  };

  return {
    sendConfirmationRequest: (email, confirmUrl, idempotencyKey) =>
      send(
        {
          to: [{ email }],
          subject: "Confirmez votre inscription aux offres",
          htmlContent: emailTemplates.marketingConfirmationRequest(confirmUrl),
        },
        idempotencyKey,
      ),
    sendSubscriptionConfirmed: (email, unsubscribeUrl, idempotencyKey) =>
      send(
        {
          to: [{ email }],
          subject: "Votre inscription aux offres est confirmée",
          htmlContent: emailTemplates.offersSubscriptionConfirmation(unsubscribeUrl),
        },
        idempotencyKey,
      ),
  };
};
