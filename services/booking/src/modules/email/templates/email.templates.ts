// Links are built by the server from FRONTEND_URL and signed tokens; they are
// still escaped for the HTML attribute context.
const escapeAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const emailTemplates = {
  marketingConfirmationRequest(confirmUrl: string) {

    return `
      <!doctype html>
      <html lang="fr">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Confirmez votre inscription aux offres</title>
        </head>
        <body style="margin:0; padding:0; background-color:#f7f4ef; font-family:Arial, sans-serif; color:#2f2f2f;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f7f4ef; padding:24px 0;">
            <tr>
              <td align="center">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px; background-color:#ffffff; border-radius:8px; overflow:hidden;">
                  <tr>
                    <td style="padding:32px;">
                      <h1 style="margin:0 0 16px; font-size:24px; line-height:1.3; color:#2f2f2f;">
                        Bonjour,
                      </h1>

                      <p style="margin:0 0 16px; font-size:16px; line-height:1.6;">
                        Vous avez demandé à recevoir les offres saisonnières et les disponibilités
                        de Stefania Ben. Merci de confirmer votre inscription :
                      </p>

                      <p style="margin:0 0 24px; font-size:16px; line-height:1.6;">
                        <a href="${escapeAttribute(confirmUrl)}">Confirmer mon inscription</a>
                      </p>

                      <p style="margin:0 0 16px; font-size:16px; line-height:1.6;">
                        Ce lien est valable 7 jours. Si vous n'êtes pas à l'origine de cette demande,
                        ignorez simplement cet e-mail : vous ne serez pas inscrit(e).
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
  offersSubscriptionConfirmation(unsubscribeUrl: string) {

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
                        Bonjour,
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
<a href="${escapeAttribute(unsubscribeUrl)}">sur ce lien</a>.                      </p>

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
