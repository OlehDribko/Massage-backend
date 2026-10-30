import type { BookingEventPayloadV1 } from "../../src/modules/bookings/booking.events.js";
import { parseBookingEvent, type BookingEvent } from "../../src/notifications/event-contract.js";

// Payloads typed with the PRODUCER's type: if the bookings module changes
// its event shape, these fixtures (and the consumer tests) stop compiling.

export const BOOKING_ID = "8f0c2b1e-4a5d-4c6e-9f7a-1b2c3d4e5f60";
export const CLIENT_PROFILE_ID = "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
export const ADMIN_PROFILE_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
export const SERVICE_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";

export const createdPayload = (overrides: Partial<BookingEventPayloadV1> = {}): BookingEventPayloadV1 => ({
  bookingId: BOOKING_ID,
  status: "confirmed",
  timeZone: "Europe/Paris",
  startsAt: "2027-03-02T08:00:00.000Z",
  endsAt: "2027-03-02T09:00:00.000Z",
  service: { id: SERVICE_ID, name: "Massage 60", durationMinutes: 60, priceCents: 6500, currency: "EUR" },
  client: { profileId: CLIENT_PROFILE_ID, name: "Anna Client", email: "anna@example.invalid", phone: "+33612345678" },
  actor: { profileId: CLIENT_PROFILE_ID, role: "client" },
  previous: null,
  cancellation: null,
  ...overrides,
});

export const rescheduledPayload = (overrides: Partial<BookingEventPayloadV1> = {}): BookingEventPayloadV1 =>
  createdPayload({
    startsAt: "2027-03-03T13:00:00.000Z",
    endsAt: "2027-03-03T14:00:00.000Z",
    previous: { startsAt: "2027-03-02T08:00:00.000Z", endsAt: "2027-03-02T09:00:00.000Z" },
    ...overrides,
  });

export const cancelledPayload = (
  by: "client" | "admin",
  reason: string | null,
  overrides: Partial<BookingEventPayloadV1> = {},
): BookingEventPayloadV1 =>
  createdPayload({
    status: "cancelled",
    actor: { profileId: by === "client" ? CLIENT_PROFILE_ID : ADMIN_PROFILE_ID, role: by },
    cancellation: { by, at: "2027-03-01T10:00:00.000Z", reason },
    ...overrides,
  });

export const eventOf = (type: string, payload: unknown): BookingEvent => {
  const parsed = parseBookingEvent({ type, schemaVersion: 1, aggregateType: "booking", aggregateId: BOOKING_ID, payload });
  if (!parsed.ok) {
    throw new Error(`fixture is not a valid event: ${parsed.reason}`);
  }
  return parsed.event;
};
