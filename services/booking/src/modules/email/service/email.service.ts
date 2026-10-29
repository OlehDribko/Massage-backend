import { BrevoClient } from "@getbrevo/brevo";
import { emailTemplates } from "../templates/email.templates.js";
import { mapBrevoError } from "../errors/email.errors.js";
import type { SendTransactionalEmailType } from "../types/email.types.js";

export type EmailServiceConfig = {
  brevoApiKey: string;
  fromName: string;
  fromEmail: string;
};

/** Marketing emails; links are built by the caller. */
export type MarketingMailer = {
  sendConfirmationRequest: (email: string, confirmUrl: string) => Promise<void>;
  sendSubscriptionConfirmed: (email: string, unsubscribeUrl: string) => Promise<void>;
};

/** Brevo transactional API. Created only when marketing is enabled. */
export const createBrevoMarketingMailer = ({
  brevoApiKey,
  fromName,
  fromEmail,
}: EmailServiceConfig): MarketingMailer => {
  const brevo = new BrevoClient({
    apiKey: brevoApiKey,
    timeoutInSeconds: 30,
    maxRetries: 3,
  });

  const send = async ({ to, subject, htmlContent }: SendTransactionalEmailType): Promise<void> => {
    try {
      await brevo.transactionalEmails.sendTransacEmail({
        subject,
        htmlContent,
        sender: { name: fromName, email: fromEmail },
        to,
      });
    } catch (error) {
      throw mapBrevoError(error);
    }
  };

  return {
    sendConfirmationRequest: (email, confirmUrl) =>
      send({
        to: [{ email }],
        subject: "Confirmez votre inscription aux offres",
        htmlContent: emailTemplates.marketingConfirmationRequest(confirmUrl),
      }),
    sendSubscriptionConfirmed: (email, unsubscribeUrl) =>
      send({
        to: [{ email }],
        subject: "Votre inscription aux offres est confirmée",
        htmlContent: emailTemplates.offersSubscriptionConfirmation(unsubscribeUrl),
      }),
  };
};
