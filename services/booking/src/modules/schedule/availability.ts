import type { BookingRules } from "./booking-rules.js";
import type { Tx } from "./calendar-transaction.js";
import {
  activeBookingTimes,
  dayScheduleOf,
  loadDaySchedule,
  loadExceptions,
  loadWeekly,
} from "./schedule.repository.js";
import { bookingWindow, daySlots, type Slot } from "./slots.js";
import {
  addDays,
  daysBetween,
  localDateTimeOf,
  localDateTimeToInstant,
  minutesToMs,
  type LocalDate,
} from "./zoned-time.js";

/** Why a requested start cannot be booked (also returned to the client). */
export type UnavailableReason =
  /** Less than minLead from now. */
  | "too_soon"
  /** After the end of the local day today + horizonDays. */
  | "beyond_horizon"
  /** Not an offered start: outside working intervals, not on the grid of its free stretch, after the latest start, or the session would not fit. */
  | "outside_schedule"
  /** Overlaps another booking or its break. */
  | "taken";

export type StartCheck = { ok: true } | { ok: false; reason: UnavailableReason };

/**
 * Server-side check of a requested start, the same rules as the public
 * availability. Run inside the calendar transaction, so the answer holds
 * until the booking is written.
 */
export const checkStart = async (
  tx: Tx,
  {
    startsAt,
    durationMinutes,
    excludeBookingId,
    now,
    rules,
  }: { startsAt: Date; durationMinutes: number; excludeBookingId?: string; now: Date; rules: BookingRules },
): Promise<StartCheck> => {
  const window = bookingWindow(now, rules);
  if (startsAt.getTime() < window.earliestStart.getTime()) {
    return { ok: false, reason: "too_soon" };
  }
  if (startsAt.getTime() >= window.horizonEnd.getTime()) {
    return { ok: false, reason: "beyond_horizon" };
  }

  const date = localDateTimeOf(startsAt, rules.timeZone).date;
  const { intervals } = await loadDaySchedule(tx, date);
  // Bookings of that day decide where free stretches (and their grids) begin.
  const occupied = await activeBookingTimes(tx, {
    from: localDateTimeToInstant(date, 0, rules.timeZone),
    to: localDateTimeToInstant(addDays(date, 1), 0, rules.timeZone),
    ...(excludeBookingId === undefined ? {} : { excludeBookingId }),
  });
  const offered = daySlots({ date, intervals, durationMinutes, occupied, window, rules });
  if (offered.some((slot) => slot.startsAt.getTime() === startsAt.getTime())) {
    return { ok: true };
  }

  const blockedUntil = startsAt.getTime() + minutesToMs(durationMinutes + rules.breakMinutes);
  const overlapsBooking = occupied.some(
    (other) => startsAt.getTime() < other.blockedUntil.getTime() && other.startsAt.getTime() < blockedUntil,
  );
  return { ok: false, reason: overlapsBooking ? "taken" : "outside_schedule" };
};

export type AvailabilityDay = { date: LocalDate; slots: Slot[] };

export type Availability = { from: LocalDate; to: LocalDate; days: AvailabilityDay[] };

/**
 * Free starts per local date for a duration, clamped to [today, today +
 * horizonDays]. Uses only times of other bookings, never who booked them.
 */
export const availableDays = async (
  db: Tx,
  {
    durationMinutes,
    from,
    to,
    now,
    rules,
  }: { durationMinutes: number; from?: LocalDate; to?: LocalDate; now: Date; rules: BookingRules },
): Promise<Availability> => {
  const window = bookingWindow(now, rules);
  const first = from === undefined || daysBetween(window.today, from) < 0 ? window.today : from;
  const last = to === undefined || daysBetween(to, window.lastDate) < 0 ? window.lastDate : to;
  if (daysBetween(first, last) < 0) {
    return { from: first, to: last, days: [] };
  }

  const weekly = await loadWeekly(db);
  const exceptions = await loadExceptions(db, { from: first, to: last });
  const occupied = await activeBookingTimes(db, {
    from: localDateTimeToInstant(first, 0, rules.timeZone),
    to: localDateTimeToInstant(addDays(last, 1), 0, rules.timeZone),
  });

  const days: AvailabilityDay[] = [];
  for (let date = first; daysBetween(date, last) >= 0; date = addDays(date, 1)) {
    const { intervals } = dayScheduleOf(date, weekly, exceptions);
    days.push({ date, slots: daySlots({ date, intervals, durationMinutes, occupied, window, rules }) });
  }
  return { from: first, to: last, days };
};
