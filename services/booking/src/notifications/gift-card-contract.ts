import { z } from "zod";
import type { InvalidEventReason } from "./event-contract.js";

/**
 * Consumer side of the gift card request outbox contract (producer:
 * src/modules/gift-cards/gift-card.events.ts, schemaVersion 1). Only the
 * studio is emailed, at once (no 30-minute delay, nothing supersedes it).
 */
export const GIFT_CARD_AGGREGATE = "gift_card_request";
export const GIFT_CARD_CREATED = "gift_card_request.created";
const SUPPORTED_SCHEMA_VERSION = 1;

const instant = z.iso.datetime({ offset: true });

export const giftCardPayloadSchema = z.object({
  requestId: z.uuid(),
  number: z.int().positive(),
  timeZone: z.string().min(1),
  amountCents: z.int().positive(),
  currency: z.literal("EUR"),
  description: z.string().min(1).nullable(),
  preferredContactChannel: z.enum(["email", "phone", "whatsapp"]),
  client: z.object({
    profileId: z.uuid(),
    name: z.string().min(1),
    email: z.string().min(1),
    phone: z.string().min(1),
  }),
  createdAt: instant,
});

export type GiftCardRequestEvent = { type: "gift_card_request.created"; payload: z.output<typeof giftCardPayloadSchema> };

export type ParsedGiftCardEvent = { ok: true; event: GiftCardRequestEvent } | { ok: false; reason: InvalidEventReason };

const validTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/** Validates one outbox row as a gift card event the worker can render. */
export const parseGiftCardEvent = (row: {
  type: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}): ParsedGiftCardEvent => {
  if (row.aggregateType !== GIFT_CARD_AGGREGATE) {
    return { ok: false, reason: "unsupported_aggregate" };
  }
  if (row.type !== GIFT_CARD_CREATED) {
    return { ok: false, reason: "unsupported_event_type" };
  }
  if (row.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported_schema_version" };
  }
  const parsed = giftCardPayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_payload" };
  }
  if (parsed.data.requestId !== row.aggregateId || !validTimeZone(parsed.data.timeZone)) {
    return { ok: false, reason: "inconsistent_payload" };
  }
  return { ok: true, event: { type: GIFT_CARD_CREATED, payload: parsed.data } };
};
