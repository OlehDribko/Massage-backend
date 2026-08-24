import { BrevoClient } from "@getbrevo/brevo";
import { emailTemplates } from "./email.templates.js";
import { mapBrevoError } from "./email.errors.js";

import type { User } from "@prisma/client";

const apiKey = process.env.BREVO_API_KEY;
if (!apiKey) {
  throw new Error("BREVO_API_KEY is not set");
}

const fromName = process.env.EMAIL_FROM_NAME;
if (!fromName) {
  throw new Error("EMAIL_FROM_NAME is not set");
}

const fromEmail = process.env.EMAIL_FROM_EMAIL;
if (!fromEmail) {
  throw new Error("EMAIL_FROM_EMAIL is not set");
}

const brevo = new BrevoClient({
  apiKey,
  timeoutInSeconds: 30,
  maxRetries: 3,
});

const emailService = {
  sendOffersSubscriptionConfirmation: async (user: User) => {
    try {
      const result = await brevo.transactionalEmails.sendTransacEmail({
        subject: "Votre inscription aux offres est confirmée",
        htmlContent: emailTemplates.offersSubscriptionConfirmation(user),
        sender: { name: fromName, email: fromEmail },
        to: [{ email: user.email, ...(user.name ? { name: user.name } : {}) }],
      });
      return result.messageId;
    } catch (error) {
      throw mapBrevoError(error);
    }
  },
};

export default emailService;
