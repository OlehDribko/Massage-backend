import { renderEmailLayout, type RenderedEmail } from "../../../shared/email/layout.js";

// Marketing emails (double opt-in). Links are built by the server from
// FRONTEND_URL and signed tokens; the layout escapes them for HTML. Signed
// with the configured sender name (EMAIL_FROM_NAME) only.

export const emailTemplates = {
  marketingConfirmationRequest(confirmUrl: string, senderName: string): RenderedEmail {
    return renderEmailLayout({
      subject: "Confirmez votre inscription aux offres",
      preheader: "Un clic pour confirmer votre inscription aux offres.",
      title: "Confirmez votre inscription",
      paragraphs: [
        "Bonjour,",
        "Vous avez demandé à recevoir les offres saisonnières et les nouvelles disponibilités. Merci de confirmer votre inscription :",
      ],
      action: { label: "Confirmer mon inscription", url: confirmUrl },
      notes: [
        "Ce lien est valable 7 jours. Si vous n’êtes pas à l’origine de cette demande, ignorez simplement cet e-mail : vous ne serez pas inscrit·e.",
      ],
      signature: ["À bientôt,", senderName],
    });
  },
  offersSubscriptionConfirmation(unsubscribeUrl: string, senderName: string): RenderedEmail {
    return renderEmailLayout({
      subject: "Votre inscription aux offres est confirmée",
      preheader: "Votre inscription aux offres est confirmée.",
      title: "Inscription confirmée",
      paragraphs: [
        "Bonjour,",
        "Votre inscription aux offres saisonnières et aux nouvelles disponibilités est bien prise en compte.",
        "Vous recevrez de temps en temps des informations sur les offres en cours et les nouveaux créneaux.",
      ],
      action: { label: "Me désinscrire", url: unsubscribeUrl },
      notes: [
        "Vous pouvez vous désinscrire à tout moment avec ce bouton. Les e-mails liés à vos rendez-vous ne sont pas concernés.",
      ],
      signature: ["À bientôt,", senderName],
    });
  },
};
