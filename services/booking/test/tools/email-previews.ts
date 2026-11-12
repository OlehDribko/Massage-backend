// Local HTML previews of every email, without sending anything:
//   npm run email:preview -w services/booking            (→ services/booking/tmp/email-previews)
//   npm run email:preview -w services/booking -- <dir>
// Sample data only (test fixtures); open index.html in a browser.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emailTemplates } from "../../src/modules/email/templates/email.templates.js";
import { renderGiftCardRequestEmail } from "../../src/notifications/gift-card-template.js";
import { renderEmail, type RenderedEmail } from "../../src/notifications/templates.js";
import { escapeHtml } from "../../src/shared/email/layout.js";
import { cancelledPayload, createdPayload, eventOf, rescheduledPayload } from "../helpers/booking-event.js";

const SENDER = process.env.EMAIL_FROM_NAME ?? "Стефанія Бень";
const FRONTEND = "https://massage-e9zb.vercel.app";
const outDir = resolve(process.argv[2] ?? "tmp/email-previews");
const options = { senderName: SENDER };

const created = eventOf("booking.created", createdPayload());
const rescheduled = eventOf("booking.rescheduled", rescheduledPayload());

const previews: [name: string, email: RenderedEmail][] = [
  ["client-created", renderEmail(created, "client", options)],
  ["client-rescheduled", renderEmail(rescheduled, "client", options)],
  ["client-cancelled-by-client", renderEmail(eventOf("booking.cancelled", cancelledPayload("client", null)), "client", options)],
  ["client-cancelled-by-studio", renderEmail(eventOf("booking.cancelled", cancelledPayload("admin", "Fermeture exceptionnelle")), "client", options)],
  ["studio-new", renderEmail(created, "studio", options)],
  ["studio-new-after-moves", renderEmail(rescheduled, "studio", { ...options, studio: { kind: "new" } })],
  ["studio-moved", renderEmail(rescheduled, "studio", options)],
  ["studio-cancelled", renderEmail(eventOf("booking.cancelled", cancelledPayload("client", null)), "studio", options)],
  [
    "studio-gift-card-request",
    renderGiftCardRequestEmail({
      type: "gift_card_request.created",
      payload: {
        requestId: "5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d",
        number: 42,
        timeZone: "Europe/Paris",
        amountCents: 15000,
        currency: "EUR",
        description: "Pour l’anniversaire de ma sœur, si possible avant samedi.",
        preferredContactChannel: "whatsapp",
        client: { profileId: "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f", name: "Anna Example", email: "anna@example.invalid", phone: "+33612345678" },
        createdAt: "2027-03-01T07:00:00.000Z",
      },
    }),
  ],
  ["marketing-confirmation-request", emailTemplates.marketingConfirmationRequest(`${FRONTEND}/marketing/confirm?token=preview`, SENDER)],
  ["marketing-subscription-confirmed", emailTemplates.offersSubscriptionConfirmation(`${FRONTEND}/unsubscribe?token=preview`, SENDER)],
];

mkdirSync(outDir, { recursive: true });
for (const [name, email] of previews) {
  writeFileSync(join(outDir, `${name}.html`), email.html);
  writeFileSync(join(outDir, `${name}.txt`), `Subject: ${email.subject}\n\n${email.text}\n`);
}
const rows = previews
  .map(
    ([name, email]) =>
      `<li><a href="${name}.html">${escapeHtml(name)}</a> · <a href="${name}.txt">text</a> — ${escapeHtml(email.subject)}</li>`,
  )
  .join("\n");
writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Email previews</title><body style="font-family:sans-serif"><h1>Email previews</h1><ul>${rows}</ul></body></html>`,
);
console.log(`${String(previews.length)} previews written to ${outDir}`);
