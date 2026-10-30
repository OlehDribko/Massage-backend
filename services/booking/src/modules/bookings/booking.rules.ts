import type { BookingRules } from "../schedule/booking-rules.js";
import { minutesToMs } from "../schedule/zoned-time.js";

/**
 * Time rules of an existing booking (pure, evaluated with the server clock).
 */

/** Rescheduling: strictly more than the cutoff (12 h) must remain; exactly 12 h is too late. */
export const rescheduleAllowed = (startsAt: Date, now: Date, rules: BookingRules): boolean =>
  startsAt.getTime() - now.getTime() > minutesToMs(rules.rescheduleCutoffMinutes);

/** Cancelling (client or admin): any time before the start, even a minute before; never from the start on. */
export const cancellationAllowed = (startsAt: Date, now: Date): boolean => now.getTime() < startsAt.getTime();

export type BookingPhase = "upcoming" | "in_progress" | "finished" | "cancelled";

export const phaseOf = (
  booking: { status: "confirmed" | "cancelled"; startsAt: Date; endsAt: Date },
  now: Date,
): BookingPhase => {
  if (booking.status === "cancelled") {
    return "cancelled";
  }
  if (now.getTime() < booking.startsAt.getTime()) {
    return "upcoming";
  }
  return now.getTime() < booking.endsAt.getTime() ? "in_progress" : "finished";
};
