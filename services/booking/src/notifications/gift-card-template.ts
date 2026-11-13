import { renderEmailLayout, type EmailDetail, type RenderedEmail } from "../shared/email/layout.js";
import type { GiftCardRequestEvent } from "./gift-card-contract.js";
import { formatDateTime, formatPrice } from "./templates.js";

/**
 * The studio's email about a new gift card request (French, shared layout).
 * Every dynamic value, the client's description included, is escaped by the
 * layout and reduced to one line; nothing is a link.
 */
const CHANNEL_LABELS: Record<GiftCardRequestEvent["payload"]["preferredContactChannel"], string> = {
  email: "E-mail",
  phone: "Téléphone",
  whatsapp: "WhatsApp",
};

const zoneLabel = (timeZone: string): string =>
  timeZone === "Europe/Paris" ? "heure de Paris" : `fuseau ${timeZone}`;

export const renderGiftCardRequestEmail = (event: GiftCardRequestEvent): RenderedEmail => {
  const { payload } = event;
  const amount = formatPrice(payload.amountCents);
  const number = `n°\u00a0${String(payload.number)}`;
  const details: EmailDetail[] = [
    ["Demande", number],
    ["Montant", amount],
    ["Client", payload.client.name],
    ["E-mail", payload.client.email],
    ["Téléphone (non vérifié)", payload.client.phone],
    ["Contact souhaité", CHANNEL_LABELS[payload.preferredContactChannel]],
    ...(payload.description === null ? [] : [["Message du client", payload.description] satisfies EmailDetail]),
    ["Date de la demande", `${formatDateTime(payload.createdAt, payload.timeZone)} (${zoneLabel(payload.timeZone)})`],
  ];
  return renderEmailLayout({
    subject: `Demande de carte cadeau ${number} : ${amount}`,
    preheader: `${payload.client.name}, ${amount}`,
    title: "Nouvelle demande de carte cadeau",
    paragraphs: [
      "Bonjour,",
      "Un client a demandé une carte cadeau. Contactez-le par le moyen souhaité pour convenir du paiement et de la remise de la carte.",
    ],
    details,
    notes: ["Aucun paiement n’a été effectué en ligne et aucune carte n’a été émise automatiquement."],
    signature: ["Message automatique du système de réservation."],
  });
};
