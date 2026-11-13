import { describe, expect, it } from "vitest";
import { parseGiftCardEvent } from "../src/notifications/gift-card-contract.js";
import { renderGiftCardRequestEmail } from "../src/notifications/gift-card-template.js";

const REQUEST_ID = "5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d";

const payload = {
  requestId: REQUEST_ID,
  number: 7,
  timeZone: "Europe/Paris",
  amountCents: 2500,
  currency: "EUR",
  description: null,
  preferredContactChannel: "email",
  client: { profileId: "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f", name: "Anna <Client>", email: "anna@example.invalid", phone: "+33612345678" },
  createdAt: "2027-07-01T10:15:00.000Z",
};

const row = (overrides: Partial<{ type: string; schemaVersion: number; aggregateType: string; aggregateId: string; payload: unknown }> = {}) => ({
  type: "gift_card_request.created",
  schemaVersion: 1,
  aggregateType: "gift_card_request",
  aggregateId: REQUEST_ID,
  payload,
  ...overrides,
});

describe("gift card request event (consumer side)", () => {
  it("accepts the producer's payload and refuses anything else with a fixed reason", () => {
    expect(parseGiftCardEvent(row()).ok).toBe(true);
    expect(parseGiftCardEvent(row({ aggregateType: "booking" }))).toEqual({ ok: false, reason: "unsupported_aggregate" });
    expect(parseGiftCardEvent(row({ type: "gift_card_request.updated" }))).toEqual({ ok: false, reason: "unsupported_event_type" });
    expect(parseGiftCardEvent(row({ schemaVersion: 2 }))).toEqual({ ok: false, reason: "unsupported_schema_version" });
    expect(parseGiftCardEvent(row({ payload: { ...payload, amountCents: 0 } }))).toEqual({ ok: false, reason: "invalid_payload" });
    expect(parseGiftCardEvent(row({ payload: { ...payload, currency: "USD" } }))).toEqual({ ok: false, reason: "invalid_payload" });
    expect(parseGiftCardEvent(row({ aggregateId: "8f0c2b1e-4a5d-4c6e-9f7a-1b2c3d4e5f60" }))).toEqual({ ok: false, reason: "inconsistent_payload" });
    expect(parseGiftCardEvent(row({ payload: { ...payload, timeZone: "Mars/Olympus" } }))).toEqual({ ok: false, reason: "inconsistent_payload" });
  });
});

describe("studio email about a gift card request", () => {
  it("French, every field, local time (summer), escaped; no description line without one", () => {
    const parsed = parseGiftCardEvent(row());
    if (!parsed.ok) {
      throw new Error("payload must parse");
    }
    const email = renderGiftCardRequestEmail(parsed.event);
    expect(email.subject).toBe("Demande de carte cadeau n° 7 : 25,00 €");
    expect(email.text).toContain("Contact souhaité : E-mail");
    expect(email.text).toContain("Téléphone (non vérifié) : +33612345678");
    expect(email.text).toContain("Date de la demande : jeudi 1 juillet 2027 à 12:15 (heure de Paris)");
    expect(email.text).not.toContain("Message du client");
    expect(email.html).toContain("Anna &lt;Client&gt;");
    expect(email.html).not.toContain("Anna <Client>");
  });
});
