import { BrevoClient } from "@getbrevo/brevo";
import { emailTemplates } from "../templates/email.templates.js";
import { mapBrevoError } from "../errors/email.errors.js";
import actionTokenService, {
  type ActionTokenPurpose,
} from "../tokens/action-token.service.js";

import type { User } from "@prisma/client";
import type { SendTransactionalEmailType } from "../types/email.types.js";

const apiKey = process.env.BREVO_API_KEY;
const fromName = process.env.EMAIL_FROM_NAME;
const fromEmail = process.env.EMAIL_FROM_EMAIL;
const frontendUrl = process.env.FRONTEND_URL;

if (!apiKey) {
  throw new Error("BREVO_API_KEY is not set");
}

if (!fromName) {
  throw new Error("EMAIL_FROM_NAME is not set");
}

if (!fromEmail) {
  throw new Error("EMAIL_FROM_EMAIL is not set");
}

if (!frontendUrl) {
  throw new Error("FRONTEND_URL is not set");
}

try {
  new URL(frontendUrl);
} catch {
  throw new Error("FRONTEND_URL must be a valid URL");
}

const brevo = new BrevoClient({
  apiKey,
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
  console.log("sendTransactionalEmail");
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

const emailService = {
  sendEmailVerificationRequest: async (user: User) => {
    console.log("sendEmailVerificationRequest");
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

export default emailService;
