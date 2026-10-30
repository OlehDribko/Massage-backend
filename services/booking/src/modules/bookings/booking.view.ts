import type { BookingRules } from "../schedule/booking-rules.js";
import { cancellationAllowed, phaseOf, rescheduleAllowed, type BookingPhase } from "./booking.rules.js";
import type { BookingWithClient } from "./booking.service.js";

type TimeRange = { startsAt: string; endsAt: string };

export type BookingHistoryEntry =
  | { type: "created"; at: string }
  | { type: "rescheduled"; at: string; from: TimeRange; to: TimeRange }
  | { type: "cancelled"; at: string; by: "client" | "admin" };

export type ClientBookingView = {
  id: string;
  status: "confirmed" | "cancelled";
  /** Derived from the server clock. */
  phase: BookingPhase;
  timeZone: string;
  startsAt: string;
  endsAt: string;
  /** Snapshot taken when the booking was created; never changed afterwards. */
  service: { id: string; name: string; durationMinutes: number; priceCents: number; currency: string };
  /** Paid at the studio; there is no online payment. */
  payment: "on_site";
  cancellation: { by: "client" | "admin"; at: string; reason: string | null } | null;
  /** UI hints only; the server re-checks on every request. */
  allowedActions: { reschedule: boolean; cancel: boolean };
  history: BookingHistoryEntry[];
  createdAt: string;
};

export type AdminBookingView = ClientBookingView & {
  client: { profileId: string; name: string | null; email: string | null; phone: string | null };
};

export const toClientBookingView = (booking: BookingWithClient, now: Date, rules: BookingRules): ClientBookingView => {
  const active = booking.status === "confirmed";
  const history: BookingHistoryEntry[] = [
    { type: "created", at: booking.createdAt.toISOString() },
    ...booking.timeChanges.map(
      (change): BookingHistoryEntry => ({
        type: "rescheduled",
        at: change.changedAt.toISOString(),
        from: { startsAt: change.previousStartsAt.toISOString(), endsAt: change.previousEndsAt.toISOString() },
        to: { startsAt: change.newStartsAt.toISOString(), endsAt: change.newEndsAt.toISOString() },
      }),
    ),
  ];
  if (booking.cancelledAt !== null && booking.cancelledBy !== null) {
    history.push({ type: "cancelled", at: booking.cancelledAt.toISOString(), by: booking.cancelledBy });
  }

  return {
    id: booking.id,
    status: booking.status,
    phase: phaseOf(booking, now),
    timeZone: rules.timeZone,
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    service: {
      id: booking.serviceId,
      name: booking.serviceName,
      durationMinutes: booking.durationMinutes,
      priceCents: booking.priceCents,
      currency: booking.currency,
    },
    payment: "on_site",
    cancellation:
      booking.cancelledAt !== null && booking.cancelledBy !== null
        ? { by: booking.cancelledBy, at: booking.cancelledAt.toISOString(), reason: booking.cancellationReason }
        : null,
    allowedActions: {
      reschedule: active && rescheduleAllowed(booking.startsAt, now, rules),
      cancel: active && cancellationAllowed(booking.startsAt, now),
    },
    history,
    createdAt: booking.createdAt.toISOString(),
  };
};

export const toAdminBookingView = (booking: BookingWithClient, now: Date, rules: BookingRules): AdminBookingView => ({
  ...toClientBookingView(booking, now, rules),
  // The client's own reschedule rights are not the admin's actions.
  allowedActions: { reschedule: false, cancel: booking.status === "confirmed" && cancellationAllowed(booking.startsAt, now) },
  client: {
    profileId: booking.client.id,
    name: booking.client.name,
    email: booking.client.email,
    phone: booking.client.phoneE164,
  },
});
