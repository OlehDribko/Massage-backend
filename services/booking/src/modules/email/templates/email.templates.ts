import type { User } from "@prisma/client";

export const emailTemplates = {
  emailVerificationRequest(user: User, verifyUrl: string) {
    const name = user.name ? ` ${user.name}` : "";

    return `
      <!doctype html>
      <html lang="fr">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Confirmez votre adresse e-mail</title>
        </head>
        <body style="margin:0; padding:0; background-color:#f7f4ef; font-family:Arial, sans-serif; color:#2f2f2f;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f7f4ef; padding:24px 0;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px; background-color:#ffffff; border-radius:8px; overflow:hidden;">
                  <tr>
                    <td style="padding:32px;">
                      <h1 style="margin:0 0 16px; font-size:24px; line-height:1.3; color:#2f2f2f;">
                        Bonjour${name},
                      </h1>

                      <p style="margin:0 0 16px; font-size:16px; line-height:1.6;">
                        Merci de confirmer que cette adresse e-mail vous appartient.
                      </p>

                      <p style="margin:0 0 24px; font-size:16px; line-height:1.6;">
                        <a href="${verifyUrl}">Confirmer mon e-mail</a>
                      </p>

                      <p style="margin:0 0 16px; font-size:16px; line-height:1.6;">
                        Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail.
                      </p>

                      <p style="margin:0; font-size:16px; line-height:1.6;">
                        À bientôt,<br />
                        Stefania Ben<br />
                        Massage bien-être
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;
  },
  offersSubscriptionConfirmation(user: User, unsubscribeUrl: string) {
    const name = user.name ? ` ${user.name}` : "";

    return `
      <!doctype html>
      <html lang="fr">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Votre inscription aux offres est confirmée</title>
        </head>
        <body style="margin:0; padding:0; background-color:#f7f4ef; font-family:Arial, sans-serif; color:#2f2f2f;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f7f4ef; padding:24px 0;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px; background-color:#ffffff; border-radius:8px; overflow:hidden;">
                  <tr>
                    <td style="padding:32px;">
                      <h1 style="margin:0 0 16px; font-size:24px; line-height:1.3; color:#2f2f2f;">
                        Bonjour${name},
                      </h1>

                      <p style="margin:0 0 16px; font-size:16px; line-height:1.6;">
                        Votre inscription pour recevoir les offres saisonnières et les disponibilités
                        de Stefania Ben a bien été prise en compte.
                      </p>

                      <p style="margin:0 0 16px; font-size:16px; line-height:1.6;">
                        Vous recevrez occasionnellement des informations sur les offres en cours,
                        les nouveaux créneaux disponibles et les actualités liées aux massages bien-être.
                      </p>

                      <p style="margin:0 0 24px; font-size:16px; line-height:1.6;">
Vous pouvez vous désinscrire à tout moment en cliquant
<a href="${unsubscribeUrl}">sur ce lien</a>.                      </p>

                      <p style="margin:0; font-size:16px; line-height:1.6;">
                        À bientôt,<br />
                        Stefania Ben<br />
                        Massage bien-être
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;
  },
  passwordResetRequest(user: User, resetUrl: string) {
    const name = user.name ? ` ${user.name}` : "";

    return `
      <!doctype html>
      <html lang="fr">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Réinitialisation de votre mot de passe</title>
        </head>
        <body style="margin:0; padding:0; background-color:#f7f4ef; font-family:Arial, sans-serif; color:#2f2f2f;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f7f4ef; padding:24px 0;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px; background-color:#ffffff; border-radius:8px; overflow:hidden;">
                  <tr>
                    <td style="padding:32px;">
                      <h1 style="margin:0 0 16px; font-size:24px; line-height:1.3; color:#2f2f2f;">
                        Bonjour${name},
                      </h1>

                      <p style="margin:0 0 16px; font-size:16px; line-height:1.6;">
                        Vous avez demandé à réinitialiser le mot de passe de votre compte.
                      </p>

                      <p style="margin:0 0 24px; font-size:16px; line-height:1.6;">
                        <a href="${resetUrl}">Réinitialiser mon mot de passe</a>
                      </p>

                      <p style="margin:0 0 16px; font-size:16px; line-height:1.6;">
                        Ce lien est valable pendant 15 minutes.
                        Si votre adresse e-mail n'était pas encore confirmée, la réinitialisation du mot de passe la confirmera également.
                        Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail.
                      </p>

                      <p style="margin:0; font-size:16px; line-height:1.6;">
                        À bientôt,<br />
                        Stefania Ben<br />
                        Massage bien-être
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;
  },
};
