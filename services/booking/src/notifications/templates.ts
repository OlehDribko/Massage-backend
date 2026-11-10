import { oneLine, renderEmailLayout, type EmailDetail, type RenderedEmail } from "../shared/email/layout.js";
import type { BookingEvent, BookingPayload } from "./event-contract.js";

/**
 * French transactional emails, one per (event type, recipient). Dynamic
 * values are escaped in HTML; every email has a plain-text version.
 * Client emails contain no internal identifiers (booking, profile, event ids)
 * and no studio-internal data. No links: the frontend has no agreed booking
 * page yet, and the emails are complete without one. Layout and colours:
 * src/shared/email/layout.ts.
 */
export type RecipientRole = "client" | "studio";

export type { RenderedEmail } from "../shared/email/layout.js";
export { escapeHtml } from "../shared/email/layout.js";

/**
 * The studio's email about a new or moved booking compares the latest state
 * with what the studio was last told (worker.ts): intermediate moves are
 * never listed.
 */
export type StudioContext =
  | { kind: "new" }
  | { kind: "moved"; previousStartsAt: string }
  | { kind: "unchanged" };

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/** "mardi 2 mars 2027 à 09:00" in the given time zone. */
export const formatDateTime = (iso: string, timeZone: string): string => {
  let formatter = dateTimeFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("fr-FR", {
      timeZone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    dateTimeFormatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(iso));
};

const groupFormatter = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

/** Integer cents → "65,00 €" (integer arithmetic only). */
export const formatPrice = (cents: number): string => {
  const euros = Math.floor(cents / 100);
  const rest = cents - euros * 100;
  return `${groupFormatter.format(euros)},${String(rest).padStart(2, "0")}\u00a0€`;
};

export const formatDuration = (minutes: number): string => `${String(minutes)}\u00a0min`;

const zoneLabel = (timeZone: string): string =>
  timeZone === "Europe/Paris" ? "heure de Paris" : `fuseau ${timeZone}`;

const when = (iso: string, payload: BookingPayload): string =>
  `${formatDateTime(iso, payload.timeZone)} (${zoneLabel(payload.timeZone)})`;

const serviceDetails = (payload: BookingPayload): EmailDetail[] => [
  ["Prestation", payload.service.name],
  ["Durée", formatDuration(payload.service.durationMinutes)],
  ["Prix", formatPrice(payload.service.priceCents)],
  ["Paiement", "sur place, le jour du rendez-vous"],
];

const clientDetails = (payload: BookingPayload): EmailDetail[] => [
  ["Client", payload.client.name ?? "(nom non renseigné)"],
  ["E-mail", payload.client.email ?? "(non renseigné)"],
  ["Téléphone", payload.client.phone ?? "(non renseigné)"],
];

const greetingFor = (payload: BookingPayload): string => {
  const name = payload.client.name === null ? "" : oneLine(payload.client.name);
  return name === "" ? "Bonjour," : `Bonjour ${name},`;
};

const reasonDetails = (reason: string | null): EmailDetail[] => (reason === null ? [] : [["Motif", reason]]);

export type RenderOptions = {
  /** Sender name from configuration (EMAIL_FROM_NAME), used as the signature of client emails. */
  senderName: string;
  /** Studio emails about a new or moved booking; defaults to what the event itself says. */
  studio?: StudioContext;
};

export const renderEmail = (event: BookingEvent, recipient: RecipientRole, options: RenderOptions): RenderedEmail => {
  const { payload } = event;
  const service = oneLine(payload.service.name);
  const at = formatDateTime(payload.startsAt, payload.timeZone);

  if (recipient === "client") {
    const greeting = greetingFor(payload);
    const signature = ["À bientôt,", options.senderName];
    switch (event.type) {
      case "booking.created":
        return renderEmailLayout({
          subject: "Votre rendez-vous est confirmé",
          preheader: `${service}, ${at}`,
          title: "Rendez-vous confirmé",
          paragraphs: [greeting, "Votre rendez-vous est confirmé. Voici le récapitulatif."],
          details: [["Date", when(payload.startsAt, payload)], ...serviceDetails(payload)],
          signature,
        });
      case "booking.rescheduled":
        return renderEmailLayout({
          subject: "Votre rendez-vous a été déplacé",
          preheader: `Nouvel horaire : ${at}`,
          title: "Rendez-vous déplacé",
          paragraphs: [greeting, "Votre rendez-vous a été déplacé. Il est confirmé au nouvel horaire ci-dessous."],
          details: [
            ["Nouvel horaire", when(payload.startsAt, payload)],
            ["Ancien horaire", when(event.payload.previous.startsAt, payload)],
            ...serviceDetails(payload),
          ],
          signature,
        });
      case "booking.cancelled":
        return renderEmailLayout({
          subject: "Votre rendez-vous a été annulé",
          preheader: `${service}, ${at}`,
          title: "Rendez-vous annulé",
          paragraphs: [
            greeting,
            event.payload.cancellation.by === "client"
              ? "Votre rendez-vous a été annulé à votre demande."
              : "Le studio a annulé votre rendez-vous.",
          ],
          details: [
            ["Date", when(payload.startsAt, payload)],
            ["Prestation", payload.service.name],
            ["Durée", formatDuration(payload.service.durationMinutes)],
            ...reasonDetails(event.payload.cancellation.reason),
          ],
          notes: ["Vous pouvez reprendre rendez-vous à tout moment."],
          signature,
        });
    }
  }

  const signature = ["Message automatique du système de réservation."];
  const studio: StudioContext =
    options.studio ??
    (event.type === "booking.rescheduled" ? { kind: "moved", previousStartsAt: event.payload.previous.startsAt } : { kind: "new" });

  if (event.type === "booking.cancelled") {
    return renderEmailLayout({
      subject: `Rendez-vous annulé : ${service}, ${at}`,
      preheader: event.payload.cancellation.by === "client" ? "Annulé par le client" : "Annulé par le studio",
      title: "Rendez-vous annulé",
      paragraphs: [
        "Bonjour,",
        event.payload.cancellation.by === "client"
          ? "Le client a annulé son rendez-vous."
          : "Le rendez-vous a été annulé par le studio.",
      ],
      details: [
        ["Date", when(payload.startsAt, payload)],
        ["Annulé par", event.payload.cancellation.by === "client" ? "le client" : "le studio"],
        ...reasonDetails(event.payload.cancellation.reason),
        ...serviceDetails(payload),
        ...clientDetails(payload),
      ],
      signature,
    });
  }
  if (studio.kind === "moved") {
    return renderEmailLayout({
      subject: `Rendez-vous déplacé : ${service}, ${at}`,
      preheader: `Nouvel horaire : ${at}`,
      title: "Rendez-vous déplacé",
      paragraphs: ["Bonjour,", "Le client a déplacé son rendez-vous."],
      details: [
        ["Nouvel horaire", when(payload.startsAt, payload)],
        ["Ancien horaire", when(studio.previousStartsAt, payload)],
        ...serviceDetails(payload),
        ...clientDetails(payload),
      ],
      signature,
    });
  }
  return renderEmailLayout({
    subject: `Nouveau rendez-vous : ${service}, ${at}`,
    preheader: `${service}, ${at}`,
    title: "Nouveau rendez-vous",
    paragraphs: ["Bonjour,", "Un nouveau rendez-vous a été réservé."],
    details: [["Date", when(payload.startsAt, payload)], ...serviceDetails(payload), ...clientDetails(payload)],
    signature,
  });
};
