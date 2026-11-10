import { describe, expect, it } from "vitest";
import { emailTemplates } from "../src/modules/email/templates/email.templates.js";
import { EMAIL_COLORS, renderEmailLayout } from "../src/shared/email/layout.js";

const SENDER = "Стефанія Бень";

describe("email layout", () => {
  const email = renderEmailLayout({
    subject: "Sujet\r\nBcc: x@y",
    preheader: "Aperçu",
    title: "Rendez-vous confirmé",
    paragraphs: ["Bonjour <b>Anna</b>,"],
    details: [["Date", "mardi 2 mars 2027 à 09:00"]],
    action: { label: "Ouvrir", url: 'https://example.invalid/a?x=1&y="2"' },
    notes: ["Note"],
    signature: ["À bientôt,", SENDER],
  });

  it("is responsive and uses the site's colours, without remote images or fonts", () => {
    expect(email.html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(email.html).toContain("max-width:560px");
    expect(email.html).toContain("@media (max-width:600px)");
    for (const colour of [EMAIL_COLORS.page, EMAIL_COLORS.accent, EMAIL_COLORS.heading]) {
      expect(email.html).toContain(colour);
    }
    expect(email.html).not.toMatch(/<img|<link|@import|url\(/);
  });

  it("escapes values, keeps the subject on one line and has a complete text twin", () => {
    expect(email.subject).toBe("Sujet Bcc: x@y");
    expect(email.html).toContain("Bonjour &lt;b&gt;Anna&lt;/b&gt;,");
    expect(email.html).toContain('href="https://example.invalid/a?x=1&amp;y=&quot;2&quot;"');
    expect(email.text).toBe(
      [
        "Rendez-vous confirmé",
        "",
        "Bonjour <b>Anna</b>,",
        "",
        "Date : mardi 2 mars 2027 à 09:00",
        "",
        'Ouvrir : https://example.invalid/a?x=1&y="2"',
        "",
        "Note",
        "",
        "À bientôt,",
        SENDER,
      ].join("\n"),
    );
  });
});

describe("marketing emails", () => {
  it("confirmation request: the link as a button and in the text, signed with the configured sender name", () => {
    const url = "https://massage-e9zb.vercel.app/marketing/confirm?token=abc.def";
    const email = emailTemplates.marketingConfirmationRequest(url, SENDER);
    expect(email.subject).toBe("Confirmez votre inscription aux offres");
    expect(email.html).toContain(`href="${url}"`);
    expect(email.text).toContain(`Confirmer mon inscription : ${url}`);
    expect(email.text).toContain("valable 7 jours");
    expect(email.text.endsWith(`À bientôt,\n${SENDER}`)).toBe(true);
    expect(`${email.html}${email.text}`).not.toMatch(/Stefania|Stefaniia/);
  });

  it("subscription confirmed: the unsubscribe link", () => {
    const url = "https://massage-e9zb.vercel.app/unsubscribe?token=abc.def";
    const email = emailTemplates.offersSubscriptionConfirmation(url, SENDER);
    expect(email.subject).toBe("Votre inscription aux offres est confirmée");
    expect(email.text).toContain(`Me désinscrire : ${url}`);
    expect(email.text).toContain("Les e-mails liés à vos rendez-vous ne sont pas concernés.");
  });
});
