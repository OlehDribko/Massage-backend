import type { Booking, UserProfile } from "../../generated/prisma/client.js";
import type { Tx } from "../schedule/calendar-transaction.js";

/**
 * Transactional outbox for a future Notifications component (emails to the
 * client and the admin). Events are written in the same transaction as the
 * booking change, so an event exists if and only if the change committed.
 * Nothing delivers them in this stage: publishedAt stays null and no email
 * is sent.
 *
 * Contract (schemaVersion 1):
 * - `id`: stable event id (UUID), for deduplication by consumers;
 * - `dedupeKey`: one event per business fact (unique in the database), so a
 *   retried request can never add a second event;
 * - payload: everything an email needs, as of the moment of the change.
 *   Admin recipients are resolved by the consumer (profiles with role admin).
 */
export const BOOKING_EVENT_SCHEMA_VERSION = 1;

export type BookingEventType = "booking.created" | "booking.rescheduled" | "booking.cancelled";

type TimeRange = { startsAt: string; endsAt: string };

export type BookingEventPayloadV1 = {
  bookingId: string;
  status: "confirmed" | "cancelled";
  timeZone: string;
  startsAt: string;
  endsAt: string;
  service: { id: string; name: string; durationMinutes: number; priceCents: number; currency: string };
  client: { profileId: string; name: string | null; email: string | null; phone: string | null };
  /** Who made the change. */
  actor: { profileId: string; role: "client" | "admin" };
  /** booking.rescheduled only: the time before the change. */
  previous: TimeRange | null;
  /** booking.cancelled only. */
  cancellation: { by: "client" | "admin"; at: string; reason: string | null } | null;
};

const payloadOf = (
  booking: Booking,
  client: UserProfile,
  actor: UserProfile,
  timeZone: string,
  previous: TimeRange | null,
): BookingEventPayloadV1 => ({
  bookingId: booking.id,
  status: booking.status,
  timeZone,
  startsAt: booking.startsAt.toISOString(),
  endsAt: booking.endsAt.toISOString(),
  service: {
    id: booking.serviceId,
    name: booking.serviceName,
    durationMinutes: booking.durationMinutes,
    priceCents: booking.priceCents,
    currency: booking.currency,
  },
  client: { profileId: client.id, name: client.name, email: client.email, phone: client.phoneE164 },
  actor: { profileId: actor.id, role: actor.role },
  previous,
  cancellation:
    booking.status === "cancelled" && booking.cancelledAt !== null && booking.cancelledBy !== null
      ? { by: booking.cancelledBy, at: booking.cancelledAt.toISOString(), reason: booking.cancellationReason }
      : null,
});

export const recordBookingEvent = async (
  tx: Tx,
  event: {
    type: BookingEventType;
    /** Business fact this event stands for; one event per key. */
    dedupeKey: string;
    booking: Booking;
    client: UserProfile;
    actor: UserProfile;
    timeZone: string;
    occurredAt: Date;
    previous?: TimeRange;
  },
): Promise<void> => {
  await tx.outboxEvent.create({
    data: {
      type: event.type,
      schemaVersion: BOOKING_EVENT_SCHEMA_VERSION,
      aggregateType: "booking",
      aggregateId: event.booking.id,
      dedupeKey: event.dedupeKey,
      payload: payloadOf(event.booking, event.client, event.actor, event.timeZone, event.previous ?? null),
      occurredAt: event.occurredAt,
    },
  });
};
