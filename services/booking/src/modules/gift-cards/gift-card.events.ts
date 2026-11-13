import type { GiftCardRequest, Prisma } from "../../generated/prisma/client.js";

/**
 * Outbox event of a new gift card request, for the Notifications component
 * (the studio's email, src/notifications). Written in the same transaction
 * as the request, so the intent to notify exists if and only if the request
 * committed. Not under the calendar lock: the planner reads unplanned events
 * by `notification IS NULL`, not by a position cursor, and each request has
 * a single event, so commit order across aggregates does not matter.
 *
 * Contract (schemaVersion 1), consumer: src/notifications/gift-card-contract.ts.
 * The payload is the snapshot of the request; the consumer never reads the
 * request or profile tables.
 */
export const GIFT_CARD_EVENT_SCHEMA_VERSION = 1;
export const GIFT_CARD_AGGREGATE_TYPE = "gift_card_request";
export const GIFT_CARD_CREATED_EVENT = "gift_card_request.created";

export type GiftCardEventPayloadV1 = {
  requestId: string;
  number: number;
  timeZone: string;
  amountCents: number;
  currency: string;
  description: string | null;
  preferredContactChannel: "email" | "phone" | "whatsapp";
  client: { profileId: string; name: string; email: string; phone: string };
  createdAt: string;
};

export const recordGiftCardRequestCreated = async (
  tx: Prisma.TransactionClient,
  request: GiftCardRequest,
  timeZone: string,
): Promise<void> => {
  const payload: GiftCardEventPayloadV1 = {
    requestId: request.id,
    number: request.number,
    timeZone,
    amountCents: request.amountCents,
    currency: request.currency,
    description: request.description,
    preferredContactChannel: request.preferredContactChannel,
    client: {
      profileId: request.clientProfileId,
      name: request.clientName,
      email: request.clientEmail,
      phone: request.clientPhone,
    },
    createdAt: request.createdAt.toISOString(),
  };
  await tx.outboxEvent.create({
    data: {
      type: GIFT_CARD_CREATED_EVENT,
      schemaVersion: GIFT_CARD_EVENT_SCHEMA_VERSION,
      aggregateType: GIFT_CARD_AGGREGATE_TYPE,
      aggregateId: request.id,
      // One event per request, so a retried request can never add a second email.
      dedupeKey: `${GIFT_CARD_CREATED_EVENT}:${request.id}`,
      payload,
      occurredAt: request.createdAt,
    },
  });
};
