import type { User } from "@prisma/client";

export const emailTemplates = {
  offersSubscriptionConfirmation(user: User) {
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
                        Vous pouvez vous désinscrire à tout moment.
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
