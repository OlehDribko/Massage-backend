import type { BookingRules } from "./booking-rules.js";
import {
  addDays,
  localDateTimeOf,
  localDateTimeToInstant,
  minutesToMs,
  type LocalDate,
} from "./zoned-time.js";

/**
 * Pure availability rules (no I/O), shared by the public availability
 * endpoint and the server-side check of a booking or rescheduling request,
 * so both always agree.
 */

/** Local wall-clock interval, minutes since local midnight, [start, end). */
export type MinuteInterval = { startMinute: number; endMinute: number };

/** Time taken by an existing confirmed booking, break included: [startsAt, blockedUntil). */
export type OccupiedTime = { startsAt: Date; blockedUntil: Date };

export type Slot = { startsAt: Date; endsAt: Date };

export type BookingWindow = {
  /** Local date of `now` in the studio time zone. */
  today: LocalDate;
  /** Last local date on which a session may start (today + horizonDays). */
  lastDate: LocalDate;
  /** Earliest allowed start: now + minLead (inclusive). */
  earliestStart: Date;
  /** Start of the local day after lastDate: starts must be strictly before it. */
  horizonEnd: Date;
};

export const bookingWindow = (now: Date, rules: BookingRules): BookingWindow => {
  const today = localDateTimeOf(now, rules.timeZone).date;
  const lastDate = addDays(today, rules.horizonDays);
  return {
    today,
    lastDate,
    earliestStart: new Date(now.getTime() + minutesToMs(rules.minLeadMinutes)),
    horizonEnd: localDateTimeToInstant(addDays(lastDate, 1), 0, rules.timeZone),
  };
};

/** Two half-open ranges overlap. */
const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart < bEnd && bStart < aEnd;

/** Instant range of a local interval on a date (DST-aware). */
export const intervalInstants = (
  date: LocalDate,
  interval: MinuteInterval,
  timeZone: string,
): { start: Date; end: Date } => ({
  start: localDateTimeToInstant(date, interval.startMinute, timeZone),
  end: localDateTimeToInstant(date, interval.endMinute, timeZone),
});

/**
 * Starts offered on one local date for a session of `durationMinutes`:
 * - every slotStepMinutes from the start of each working interval (elapsed
 *   time, so a step never lands on a non-existent local time);
 * - the session ends within the interval (the break after it need not fit);
 * - starts no later than latestStartMinuteOfDay local time;
 * - within [earliestStart, horizonEnd);
 * - [start, end + break) overlaps no occupied time, so the break is kept
 *   both before and after every other booking.
 */
export const daySlots = ({
  date,
  intervals,
  durationMinutes,
  occupied,
  window,
  rules,
}: {
  date: LocalDate;
  intervals: MinuteInterval[];
  durationMinutes: number;
  occupied: OccupiedTime[];
  window: BookingWindow;
  rules: BookingRules;
}): Slot[] => {
  const duration = minutesToMs(durationMinutes);
  const blocked = duration + minutesToMs(rules.breakMinutes);
  const step = minutesToMs(rules.slotStepMinutes);
  const latestStart = localDateTimeToInstant(date, rules.latestStartMinuteOfDay, rules.timeZone).getTime();
  const earliest = window.earliestStart.getTime();
  const horizonEnd = window.horizonEnd.getTime();

  const starts = new Set<number>();
  for (const interval of intervals) {
    const { start, end } = intervalInstants(date, interval, rules.timeZone);
    for (let t = start.getTime(); t + duration <= end.getTime() && t <= latestStart; t += step) {
      if (t < earliest || t >= horizonEnd) {
        continue;
      }
      const taken = occupied.some((other) =>
        overlaps(t, t + blocked, other.startsAt.getTime(), other.blockedUntil.getTime()),
      );
      if (!taken) {
        starts.add(t);
      }
    }
  }

  return [...starts]
    .sort((a, b) => a - b)
    .map((t) => ({ startsAt: new Date(t), endsAt: new Date(t + duration) }));
};

/** Whether a session lies entirely inside one working interval of its local date. */
export const fitsWorkingIntervals = (
  booking: { startsAt: Date; endsAt: Date },
  date: LocalDate,
  intervals: MinuteInterval[],
  timeZone: string,
): boolean =>
  intervals.some((interval) => {
    const { start, end } = intervalInstants(date, interval, timeZone);
    return start.getTime() <= booking.startsAt.getTime() && booking.endsAt.getTime() <= end.getTime();
  });

/** Whether two intervals of one day overlap (validation of schedule input). */
export const hasOverlap = (intervals: MinuteInterval[]): boolean => {
  const sorted = [...intervals].sort((a, b) => a.startMinute - b.startMinute);
  return sorted.some((interval, index) => {
    const next = sorted[index + 1];
    return next !== undefined && next.startMinute < interval.endMinute;
  });
};
