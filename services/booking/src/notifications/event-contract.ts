import { z } from "zod";

/**
 * Consumer side of the booking outbox contract (producer:
 * src/modules/bookings/booking.events.ts, schemaVersion 1). The worker learns
 * everything about a booking from the event itself; it never reads
 * catalogue, profile or booking tables. An event it cannot use is recorded
 * as invalid with a safe reason code, never silently dropped.
 */
export const SUPPORTED_SCHEMA_VERSION = 1;

export const eventTypeSchema = z.enum(["booking.created", "booking.rescheduled", "booking.cancelled"]);
export type BookingEventType = z.output<typeof eventTypeSchema>;

const instant = z.iso.datetime({ offset: true });
const timeRange = z.object({ startsAt: instant, endsAt: instant });

export const bookingPayloadSchema = z.object({
  bookingId: z.uuid(),
  status: z.enum(["confirmed", "cancelled"]),
  timeZone: z.string().min(1),
  startsAt: instant,
  endsAt: instant,
  service: z.object({
    id: z.uuid(),
    name: z.string().min(1),
    durationMinutes: z.int().positive(),
    priceCents: z.int().nonnegative(),
    currency: z.literal("EUR"),
  }),
  client: z.object({
    profileId: z.uuid(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  actor: z.object({ profileId: z.uuid(), role: z.enum(["client", "admin"]) }),
  previous: timeRange.nullable(),
  cancellation: z
    .object({ by: z.enum(["client", "admin"]), at: instant, reason: z.string().nullable() })
    .nullable(),
});

export type BookingPayload = z.output<typeof bookingPayloadSchema>;

export type BookingEvent =
  | { type: "booking.created"; payload: BookingPayload }
  | { type: "booking.rescheduled"; payload: BookingPayload & { previous: z.output<typeof timeRange> } }
  | {
      type: "booking.cancelled";
      payload: BookingPayload & { cancellation: NonNullable<BookingPayload["cancellation"]> };
    };

/** Safe, fixed reason codes for events that cannot be used. */
export type InvalidEventReason =
  | "unsupported_aggregate"
  | "unsupported_event_type"
  | "unsupported_schema_version"
  | "invalid_payload"
  | "inconsistent_payload";

export type ParsedEvent = { ok: true; event: BookingEvent } | { ok: false; reason: InvalidEventReason };

const validTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/** Validates one outbox row as a booking event the worker can render. */
export const parseBookingEvent = (row: {
  type: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}): ParsedEvent => {
  if (row.aggregateType !== "booking") {
    return { ok: false, reason: "unsupported_aggregate" };
  }
  const type = eventTypeSchema.safeParse(row.type);
  if (!type.success) {
    return { ok: false, reason: "unsupported_event_type" };
  }
  if (row.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported_schema_version" };
  }
  const parsed = bookingPayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    return { ok: false, reason: "invalid_payload" };
  }
  const payload = parsed.data;
  if (payload.bookingId !== row.aggregateId || !validTimeZone(payload.timeZone)) {
    return { ok: false, reason: "inconsistent_payload" };
  }

  switch (type.data) {
    case "booking.created":
      return payload.status === "confirmed"
        ? { ok: true, event: { type: "booking.created", payload } }
        : { ok: false, reason: "inconsistent_payload" };
    case "booking.rescheduled": {
      const previous = payload.previous;
      return payload.status === "confirmed" && previous !== null
        ? { ok: true, event: { type: "booking.rescheduled", payload: { ...payload, previous } } }
        : { ok: false, reason: "inconsistent_payload" };
    }
    case "booking.cancelled": {
      const cancellation = payload.cancellation;
      return payload.status === "cancelled" && cancellation !== null
        ? { ok: true, event: { type: "booking.cancelled", payload: { ...payload, cancellation } } }
        : { ok: false, reason: "inconsistent_payload" };
    }
  }
};
