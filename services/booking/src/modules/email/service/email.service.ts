import { BrevoClient } from "@getbrevo/brevo";
import { emailTemplates } from "../templates/email.templates.js";
import { mapBrevoError } from "../errors/email.errors.js";
import type {
  ActionTokenPurpose,
  ActionTokenService,
} from "../tokens/action-token.service.js";
import type { Logger } from "../../../logging/logger.js";

import type { User } from "../../../generated/prisma/client.js";
import type { SendTransactionalEmailType } from "../types/email.types.js";

export type EmailServiceConfig = {
  brevoApiKey: string;
  fromName: string;
  fromEmail: string;
  frontendUrl: string;
};

export type EmailService = ReturnType<typeof createEmailService>;

/** Creates the Brevo client only when called (legacy routes enabled). */
export const createEmailService = (
  { brevoApiKey, fromName, fromEmail, frontendUrl }: EmailServiceConfig,
  actionTokenService: ActionTokenService,
  logger: Logger,
) => {
  const brevo = new BrevoClient({
    apiKey: brevoApiKey,
    timeoutInSeconds: 30,
    maxRetries: 3,
  });

  const buildActionUrl = (
    path: "/unsubscribe" | "/verify-email" | "/reset-password",
    purpose: ActionTokenPurpose,
    userId: string,
  ) => {
    const token = actionTokenService.createToken(userId, purpose);
    const url = new URL(path, frontendUrl);
    url.searchParams.set("token", token);
    return url.toString();
  };

  const buildUnsubscribeUrl = (userId: string) => {
    return buildActionUrl("/unsubscribe", "marketing_unsubscribe", userId);
  };

  const buildVerifyEmailUrl = (userId: string) => {
    return buildActionUrl("/verify-email", "email_verify", userId);
  };

  const buildResetPasswordUrl = (userId: string) => {
    return buildActionUrl("/reset-password", "password_reset", userId);
  };

  const sendTransactionalEmail = async ({
    to,
    subject,
    htmlContent,
  }: SendTransactionalEmailType) => {
    logger.debug("sendTransactionalEmail");
    try {
      const result = await brevo.transactionalEmails.sendTransacEmail({
        subject,
        htmlContent,
        sender: { name: fromName, email: fromEmail },
        to,
      });
      return result.messageId;
    } catch (error) {
      throw mapBrevoError(error);
    }
  };

  return {
    sendEmailVerificationRequest: async (user: User) => {
      logger.debug("sendEmailVerificationRequest");
      const verifyUrl = buildVerifyEmailUrl(user.id);
      const to = [
        {
          email: user.email,
          ...(user.name ? { name: user.name } : {}),
        },
      ];

      return sendTransactionalEmail({
        to,
        subject: "Confirmez votre adresse e-mail",
        htmlContent: emailTemplates.emailVerificationRequest(user, verifyUrl),
      });
    },
    sendOffersSubscriptionConfirmation: async (user: User) => {
      const unsubscribeUrl = buildUnsubscribeUrl(user.id);
      const to = [
        {
          email: user.email,
          ...(user.name ? { name: user.name } : {}),
        },
      ];
      const subject = "Votre inscription aux offres est confirmée";
      const htmlContent = emailTemplates.offersSubscriptionConfirmation(
        user,
        unsubscribeUrl,
      );
      const emailData = {
        to,
        subject,
        htmlContent,
      };
      return sendTransactionalEmail(emailData);
    },
    sendPasswordResetRequest: async (user: User) => {
      const resetUrl = buildResetPasswordUrl(user.id);
      const to = [
        {
          email: user.email,
          ...(user.name ? { name: user.name } : {}),
        },
      ];

      return sendTransactionalEmail({
        to,
        subject: "Réinitialisation de votre mot de passe",
        htmlContent: emailTemplates.passwordResetRequest(user, resetUrl),
      });
    },
  };
};
