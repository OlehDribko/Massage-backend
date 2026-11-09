import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../shared/errors/app-error.js";
import type { BookingRules } from "./booking-rules.js";
import type { CalendarTransaction, Tx } from "./calendar-transaction.js";
import {
  activeBookingTimes,
  dayScheduleOf,
  deleteException,
  loadExceptions,
  loadWeekly,
  putDays,
  putException,
  replaceWeekly,
} from "./schedule.repository.js";
import type { DayChange, WeeklyInterval } from "./schedule.schema.js";
import { fitsWorkingIntervals, type MinuteInterval } from "./slots.js";
import { addDays, daysBetween, isoWeekday, localDateTimeOf, type LocalDate } from "./zoned-time.js";

export type ScheduleConflict = { bookingId: string; startsAt: string; endsAt: string; serviceName: string };

/** Working hours in effect on one date. */
export type DayView = { date: LocalDate; weekday: number; intervals: MinuteInterval[]; source: "weekly" | "exception" };

export type ScheduleService = ReturnType<typeof createScheduleService>;

/**
 * Weekly schedule and date exceptions (admin). A change never silently
 * cancels or damages a booking: if an active booking (not yet ended) would
 * no longer lie inside the working intervals of its date, the change is
 * refused with 409 SCHEDULE_CONFLICT listing those bookings; the admin first
 * decides their fate (e.g. cancels them) and then retries. Checked and
 * written under the calendar lock, so no booking can slip in between.
 */
export const createScheduleService = ({
  prisma,
  calendar,
  rules,
  now,
}: {
  prisma: PrismaClient;
  calendar: CalendarTransaction;
  rules: BookingRules;
  now: () => Date;
}) => {
  const localDateOf = (instant: Date): LocalDate => localDateTimeOf(instant, rules.timeZone).date;

  /**
   * Active bookings (not yet ended) that would not fit the new intervals of
   * their date. `newIntervalsOf` returns undefined for dates the change does
   * not touch.
   */
  const conflictsWith = async (
    tx: Tx,
    newIntervalsOf: (date: LocalDate) => MinuteInterval[] | undefined,
  ): Promise<ScheduleConflict[]> => {
    const current = now();
    const bookings = await activeBookingTimes(tx, { from: current });
    return bookings
      .filter((booking) => {
        if (booking.endsAt.getTime() <= current.getTime()) {
          return false;
        }
        const date = localDateOf(booking.startsAt);
        const intervals = newIntervalsOf(date);
        return intervals !== undefined && !fitsWorkingIntervals(booking, date, intervals, rules.timeZone);
      })
      .map((booking) => ({
        bookingId: booking.id,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        serviceName: booking.serviceName,
      }));
  };

  const refuseIfConflicts = (conflicts: ScheduleConflict[]): void => {
    if (conflicts.length > 0) {
      throw new AppError(409, "The change would leave active bookings outside the working hours; resolve them first", {
        code: "SCHEDULE_CONFLICT",
        details: { conflicts },
      });
    }
  };

  const getWeekly = (): Promise<WeeklyInterval[]> => loadWeekly(prisma);

  const listExceptions = (range: { from: LocalDate; to?: LocalDate }) => loadExceptions(prisma, range);

  /** Replaces the whole weekly schedule. Dates with an exception are not affected by it. */
  const setWeekly = (intervals: WeeklyInterval[]): Promise<void> =>
    calendar(async (tx) => {
      const exceptions = await loadExceptions(tx, { from: localDateOf(now()) });
      refuseIfConflicts(
        await conflictsWith(tx, (date) =>
          exceptions.has(date) ? undefined : dayScheduleOf(date, intervals, new Map()).intervals,
        ),
      );
      await replaceWeekly(tx, intervals);
    });

  /** Own intervals for one date; [] = day off. */
  const setException = (date: LocalDate, intervals: MinuteInterval[]): Promise<void> =>
    calendar(async (tx) => {
      refuseIfConflicts(
        await conflictsWith(tx, (bookingDate) => (bookingDate === date ? intervals : undefined)),
      );
      await putException(tx, date, intervals);
    });

  /** Back to the weekly rule for that date. false when there was no exception. */
  const removeException = (date: LocalDate): Promise<boolean> =>
    calendar(async (tx) => {
      const weekly = await loadWeekly(tx);
      refuseIfConflicts(
        await conflictsWith(tx, (bookingDate) =>
          bookingDate === date ? dayScheduleOf(date, weekly, new Map()).intervals : undefined,
        ),
      );
      return deleteException(tx, date);
    });

  const daysOf = (
    dates: LocalDate[],
    weekly: WeeklyInterval[],
    exceptions: Map<LocalDate, MinuteInterval[]>,
  ): DayView[] =>
    dates.map((date) => ({ date, weekday: isoWeekday(date), ...dayScheduleOf(date, weekly, exceptions) }));

  /** Hours in effect on every date of [from, to] (a week, a month): the exception of the date, else the weekly rule. */
  const getDays = async (range: { from: LocalDate; to: LocalDate }): Promise<DayView[]> => {
    const dates = Array.from({ length: daysBetween(range.from, range.to) + 1 }, (_, index) => addDays(range.from, index));
    return daysOf(dates, await loadWeekly(prisma), await loadExceptions(prisma, range));
  };

  /**
   * Several dates at once, all or nothing: own intervals ([] = day off) or
   * back to the weekly rule. Refused as a whole if an active booking of any of
   * them would fall outside. Returns the hours now in effect on these dates.
   */
  const setDays = (changes: DayChange[]): Promise<DayView[]> =>
    calendar(async (tx) => {
      const weekly = await loadWeekly(tx);
      const exceptions = new Map<LocalDate, MinuteInterval[]>();
      const backToWeekly: LocalDate[] = [];
      for (const change of changes) {
        if (change.kind === "exception") {
          exceptions.set(change.date, change.intervals);
        } else {
          backToWeekly.push(change.date);
        }
      }
      const changed = new Set(changes.map((change) => change.date));
      refuseIfConflicts(
        await conflictsWith(tx, (date) => (changed.has(date) ? dayScheduleOf(date, weekly, exceptions).intervals : undefined)),
      );
      await putDays(tx, { exceptions, weekly: backToWeekly });
      return daysOf([...changed].sort(), weekly, exceptions);
    });

  return { getWeekly, listExceptions, setWeekly, setException, removeException, getDays, setDays };
};
