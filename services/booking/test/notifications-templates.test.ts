import { describe, expect, it } from "vitest";
import { parseBookingEvent } from "../src/notifications/event-contract.js";
import { escapeHtml, formatDateTime, formatPrice, renderEmail, type RenderedEmail } from "../src/notifications/templates.js";
import {
  ADMIN_PROFILE_ID,
  BOOKING_ID,
  CLIENT_PROFILE_ID,
  SERVICE_ID,
  cancelledPayload,
  createdPayload,
  eventOf,
  rescheduledPayload,
} from "./helpers/booking-event.js";

const all = (email: RenderedEmail): string => `${email.subject}\n${email.html}\n${email.text}`;

const INTERNAL = [BOOKING_ID, CLIENT_PROFILE_ID, ADMIN_PROFILE_ID, SERVICE_ID, "profileId", "bookingId", "admin"];

describe("French formatting", () => {
  it("dates in Europe/Paris across daylight saving changes", () => {
    expect(formatDateTime("2027-03-02T08:00:00Z", "Europe/Paris")).toBe("mardi 2 mars 2027 à 09:00");
    expect(formatDateTime("2027-03-28T07:00:00Z", "Europe/Paris")).toBe("dimanche 28 mars 2027 à 09:00");
    expect(formatDateTime("2027-10-31T08:00:00Z", "Europe/Paris")).toBe("dimanche 31 octobre 2027 à 09:00");
    expect(formatDateTime("2027-10-30T07:00:00Z", "Europe/Paris")).toBe("samedi 30 octobre 2027 à 09:00");
  });

  it("prices from integer cents in EUR", () => {
    expect(formatPrice(6500)).toBe("65,00\u00a0€");
    expect(formatPrice(5)).toBe("0,05\u00a0€");
    expect(formatPrice(0)).toBe("0,00\u00a0€");
    expect(formatPrice(123456)).toBe("1\u202f234,56\u00a0€");
  });

  it("escapes HTML", () => {
    expect(escapeHtml(`<b>"Tom" & 'Jerry'</b>`)).toBe("&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;");
  });
});

describe("client emails: content matches the event, nothing internal", () => {
  it("booking.created", () => {
    const email = renderEmail(eventOf("booking.created", createdPayload()), "client");
    expect(email.subject).toBe("Votre rendez-vous est confirmé");
    expect(email.text).toContain("Bonjour Anna Client,");
    expect(email.text).toContain("Date : mardi 2 mars 2027 à 09:00 (heure de Paris)");
    expect(email.text).toContain("Prestation : Massage 60");
    expect(email.text).toContain("Durée : 60\u00a0min");
    expect(email.text).toContain("Prix : 65,00\u00a0€ — paiement sur place");
    for (const internal of [...INTERNAL, "+33612345678", "anna@example.invalid"]) {
      expect(all(email)).not.toContain(internal);
    }
    expect(all(email)).not.toMatch(/https?:\/\//);
  });

  it("booking.rescheduled: old and new time, complete on its own", () => {
    const email = renderEmail(eventOf("booking.rescheduled", rescheduledPayload()), "client");
    expect(email.subject).toBe("Votre rendez-vous a été déplacé");
    expect(email.text).toContain("Ancien horaire : mardi 2 mars 2027 à 09:00 (heure de Paris)");
    expect(email.text).toContain("Nouvel horaire : mercredi 3 mars 2027 à 14:00 (heure de Paris)");
    expect(email.text).toContain("confirmé au nouvel horaire");
    expect(email.text).toContain("Prix : 65,00\u00a0€ — paiement sur place");
    for (const internal of INTERNAL) {
      expect(all(email)).not.toContain(internal);
    }
  });

  it("booking.cancelled by the client and by the studio (reason only when given)", () => {
    const byClient = renderEmail(eventOf("booking.cancelled", cancelledPayload("client", null)), "client");
    expect(byClient.subject).toBe("Votre rendez-vous a été annulé");
    expect(byClient.text).toContain("annulé à votre demande");
    expect(byClient.text).not.toContain("Motif");

    const byStudio = renderEmail(eventOf("booking.cancelled", cancelledPayload("admin", "Studio fermé")), "client");
    expect(byStudio.text).toContain("Le studio a annulé votre rendez-vous.");
    expect(byStudio.text).toContain("Motif : Studio fermé");
    expect(byStudio.text).toContain("Durée : 60\u00a0min");
    for (const internal of INTERNAL) {
      expect(all(byStudio)).not.toContain(internal);
    }
  });

  it("greets without a name when the profile has none", () => {
    const email = renderEmail(
      eventOf("booking.created", createdPayload({ client: { profileId: CLIENT_PROFILE_ID, name: null, email: "a@example.invalid", phone: null } })),
      "client",
    );
    expect(email.text.startsWith("Bonjour,")).toBe(true);
  });
});

describe("studio emails: client contacts and who cancelled", () => {
  it("booking.created", () => {
    const email = renderEmail(eventOf("booking.created", createdPayload()), "studio");
    expect(email.subject).toBe("Nouveau rendez-vous : Massage 60, mardi 2 mars 2027 à 09:00");
    expect(email.text).toContain("Client : Anna Client");
    expect(email.text).toContain("E-mail : anna@example.invalid");
    expect(email.text).toContain("Téléphone : +33612345678");
    expect(email.text).toContain("Prix : 65,00\u00a0€ — paiement sur place");
    expect(all(email)).not.toContain(CLIENT_PROFILE_ID);
  });

  it("booking.rescheduled", () => {
    const email = renderEmail(eventOf("booking.rescheduled", rescheduledPayload()), "studio");
    expect(email.subject).toBe("Rendez-vous déplacé : Massage 60, mercredi 3 mars 2027 à 14:00");
    expect(email.text).toContain("Ancien horaire : mardi 2 mars 2027 à 09:00");
    expect(email.text).toContain("Nouvel horaire : mercredi 3 mars 2027 à 14:00");
  });

  it("booking.cancelled", () => {
    const byClient = renderEmail(eventOf("booking.cancelled", cancelledPayload("client", null)), "studio");
    expect(byClient.subject).toBe("Rendez-vous annulé : Massage 60, mardi 2 mars 2027 à 09:00");
    expect(byClient.text).toContain("Annulé par : le client");
    const byStudio = renderEmail(eventOf("booking.cancelled", cancelledPayload("admin", "Fermeture")), "studio");
    expect(byStudio.text).toContain("Annulé par : le studio");
    expect(byStudio.text).toContain("Motif : Fermeture");
  });

  it("escapes dynamic values in HTML and keeps subjects on one line", () => {
    const hostile = createdPayload({
      service: { id: SERVICE_ID, name: "Massage <img src=x onerror=alert(1)>\r\nBcc: x@y", durationMinutes: 60, priceCents: 6500, currency: "EUR" },
      client: { profileId: CLIENT_PROFILE_ID, name: `"><script>alert(1)</script>`, email: "anna@example.invalid", phone: null },
    });
    const email = renderEmail(eventOf("booking.created", hostile), "studio");
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.text).toContain("Téléphone : (non renseigné)");
  });
});

describe("event contract (consumer side)", () => {
  const row = (type: string, payload: unknown, extra: Partial<{ schemaVersion: number; aggregateType: string; aggregateId: string }> = {}) =>
    parseBookingEvent({ type, schemaVersion: 1, aggregateType: "booking", aggregateId: BOOKING_ID, payload, ...extra });

  it("accepts the producer's payloads", () => {
    expect(row("booking.created", createdPayload()).ok).toBe(true);
    expect(row("booking.rescheduled", rescheduledPayload()).ok).toBe(true);
    expect(row("booking.cancelled", cancelledPayload("admin", "x")).ok).toBe(true);
  });

  it("reports unusable events with a safe reason code", () => {
    expect(row("booking.paid", createdPayload())).toEqual({ ok: false, reason: "unsupported_event_type" });
    expect(row("booking.created", createdPayload(), { schemaVersion: 2 })).toEqual({ ok: false, reason: "unsupported_schema_version" });
    expect(row("booking.created", createdPayload(), { aggregateType: "order" })).toEqual({ ok: false, reason: "unsupported_aggregate" });
    expect(row("booking.created", { bookingId: BOOKING_ID })).toEqual({ ok: false, reason: "invalid_payload" });
    expect(row("booking.created", createdPayload(), { aggregateId: SERVICE_ID })).toEqual({ ok: false, reason: "inconsistent_payload" });
    expect(row("booking.rescheduled", createdPayload())).toEqual({ ok: false, reason: "inconsistent_payload" });
    expect(row("booking.cancelled", createdPayload())).toEqual({ ok: false, reason: "inconsistent_payload" });
    expect(row("booking.created", createdPayload({ timeZone: "Mars/Olympus" }))).toEqual({ ok: false, reason: "inconsistent_payload" });
  });
});
