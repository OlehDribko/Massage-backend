import type { BookingEvent, BookingPayload } from "./event-contract.js";

/**
 * French transactional emails, one per (event type, recipient). Dynamic
 * values are escaped in HTML; every email has a plain-text version.
 * Client emails contain no internal identifiers (booking, profile, event ids)
 * and no studio-internal data. No links: the frontend has no agreed booking
 * page yet, and the emails are complete without one.
 */
export type RecipientRole = "client" | "studio";

export type RenderedEmail = { subject: string; html: string; text: string };

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

/** Single line, no control characters (subjects and table values). */
const oneLine = (value: string): string =>
  Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : char;
  })
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();

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

type Fact = [label: string, value: string];

const render = ({
  subject,
  greeting,
  paragraphs,
  facts,
  closing,
}: {
  subject: string;
  greeting: string;
  paragraphs: string[];
  facts: Fact[];
  closing: string;
}): RenderedEmail => {
  const cleanFacts = facts.map(([label, value]): Fact => [label, oneLine(value)]);
  const text = [
    greeting,
    "",
    ...paragraphs.flatMap((paragraph) => [paragraph, ""]),
    ...cleanFacts.map(([label, value]) => `${label} : ${value}`),
    "",
    closing,
  ].join("\n");
  const html = [
    "<!doctype html>",
    '<html lang="fr"><body style="font-family:Arial,Helvetica,sans-serif;color:#222;line-height:1.5">',
    `<p>${escapeHtml(greeting)}</p>`,
    ...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    '<table role="presentation" style="border-collapse:collapse">',
    ...cleanFacts.map(
      ([label, value]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#555">${escapeHtml(label)}</td><td style="padding:2px 0"><strong>${escapeHtml(value)}</strong></td></tr>`,
    ),
    "</table>",
    `<p>${escapeHtml(closing)}</p>`,
    "</body></html>",
  ].join("\n");
  return { subject: oneLine(subject), html, text };
};

const when = (iso: string, payload: BookingPayload): string =>
  `${formatDateTime(iso, payload.timeZone)} (${zoneLabel(payload.timeZone)})`;

const serviceFacts = (payload: BookingPayload): Fact[] => [
  ["Prestation", payload.service.name],
  ["Durée", formatDuration(payload.service.durationMinutes)],
  ["Prix", `${formatPrice(payload.service.priceCents)} — paiement sur place`],
];

const clientFacts = (payload: BookingPayload): Fact[] => [
  ["Client", payload.client.name ?? "(nom non renseigné)"],
  ["E-mail", payload.client.email ?? "(non renseigné)"],
  ["Téléphone", payload.client.phone ?? "(non renseigné)"],
];

const greetingFor = (payload: BookingPayload): string => {
  const name = payload.client.name === null ? "" : oneLine(payload.client.name);
  return name === "" ? "Bonjour," : `Bonjour ${name},`;
};

const reasonFacts = (reason: string | null): Fact[] => (reason === null ? [] : [["Motif", reason]]);

export const renderEmail = (event: BookingEvent, recipient: RecipientRole): RenderedEmail => {
  const { payload } = event;
  const service = oneLine(payload.service.name);

  if (recipient === "client") {
    const greeting = greetingFor(payload);
    const closing = "À bientôt.";
    switch (event.type) {
      case "booking.created":
        return render({
          subject: "Votre rendez-vous est confirmé",
          greeting,
          paragraphs: ["Votre rendez-vous est confirmé."],
          facts: [["Date", when(payload.startsAt, payload)], ...serviceFacts(payload)],
          closing,
        });
      case "booking.rescheduled":
        return render({
          subject: "Votre rendez-vous a été déplacé",
          greeting,
          paragraphs: ["Votre rendez-vous a été déplacé. Il est confirmé au nouvel horaire ci-dessous."],
          facts: [
            ["Ancien horaire", when(event.payload.previous.startsAt, payload)],
            ["Nouvel horaire", when(payload.startsAt, payload)],
            ...serviceFacts(payload),
          ],
          closing,
        });
      case "booking.cancelled":
        return render({
          subject: "Votre rendez-vous a été annulé",
          greeting,
          paragraphs: [
            event.payload.cancellation.by === "client"
              ? "Votre rendez-vous a été annulé à votre demande."
              : "Le studio a annulé votre rendez-vous.",
          ],
          facts: [
            ["Date", when(payload.startsAt, payload)],
            ["Prestation", payload.service.name],
            ["Durée", formatDuration(payload.service.durationMinutes)],
            ...reasonFacts(event.payload.cancellation.reason),
          ],
          closing: "Vous pouvez reprendre rendez-vous à tout moment.",
        });
    }
  }

  const closing = "Message automatique du système de réservation.";
  switch (event.type) {
    case "booking.created":
      return render({
        subject: `Nouveau rendez-vous : ${service}, ${formatDateTime(payload.startsAt, payload.timeZone)}`,
        greeting: "Bonjour,",
        paragraphs: ["Un nouveau rendez-vous a été réservé."],
        facts: [["Date", when(payload.startsAt, payload)], ...serviceFacts(payload), ...clientFacts(payload)],
        closing,
      });
    case "booking.rescheduled":
      return render({
        subject: `Rendez-vous déplacé : ${service}, ${formatDateTime(payload.startsAt, payload.timeZone)}`,
        greeting: "Bonjour,",
        paragraphs: ["Le client a déplacé son rendez-vous."],
        facts: [
          ["Ancien horaire", when(event.payload.previous.startsAt, payload)],
          ["Nouvel horaire", when(payload.startsAt, payload)],
          ...serviceFacts(payload),
          ...clientFacts(payload),
        ],
        closing,
      });
    case "booking.cancelled":
      return render({
        subject: `Rendez-vous annulé : ${service}, ${formatDateTime(payload.startsAt, payload.timeZone)}`,
        greeting: "Bonjour,",
        paragraphs: [
          event.payload.cancellation.by === "client"
            ? "Le client a annulé son rendez-vous."
            : "Le rendez-vous a été annulé par le studio.",
        ],
        facts: [
          ["Date", when(payload.startsAt, payload)],
          ["Annulé par", event.payload.cancellation.by === "client" ? "le client" : "le studio"],
          ...reasonFacts(event.payload.cancellation.reason),
          ...serviceFacts(payload),
          ...clientFacts(payload),
        ],
        closing,
      });
  }
};
