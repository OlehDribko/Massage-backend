import type { Tx } from "./calendar-transaction.js";
import type { WeeklyInterval } from "./schedule.schema.js";
import type { MinuteInterval } from "./slots.js";
import { isoWeekday, localDateFromDb, localDateToDb, type LocalDate } from "./zoned-time.js";

/** Working intervals of a date: its exception if any, else the weekly rule. */
export type DaySchedule = { intervals: MinuteInterval[]; source: "weekly" | "exception" };

const byStart = (a: MinuteInterval, b: MinuteInterval): number => a.startMinute - b.startMinute;

export const loadWeekly = async (db: Tx): Promise<WeeklyInterval[]> => {
  const rows = await db.weeklyScheduleInterval.findMany({
    orderBy: [{ weekday: "asc" }, { startMinute: "asc" }],
  });
  return rows.map((row) => ({ weekday: row.weekday, startMinute: row.startMinute, endMinute: row.endMinute }));
};

export const loadExceptions = async (
  db: Tx,
  range: { from: LocalDate; to?: LocalDate },
): Promise<Map<LocalDate, MinuteInterval[]>> => {
  const rows = await db.scheduleException.findMany({
    where: {
      date: {
        gte: localDateToDb(range.from),
        ...(range.to === undefined ? {} : { lte: localDateToDb(range.to) }),
      },
    },
    include: { intervals: true },
    orderBy: { date: "asc" },
  });
  return new Map(
    rows.map((row) => [
      localDateFromDb(row.date),
      row.intervals.map((interval) => ({ startMinute: interval.startMinute, endMinute: interval.endMinute })).sort(byStart),
    ]),
  );
};

/** Resolves the working intervals of a date from preloaded rules. */
export const dayScheduleOf = (
  date: LocalDate,
  weekly: WeeklyInterval[],
  exceptions: Map<LocalDate, MinuteInterval[]>,
): DaySchedule => {
  const exception = exceptions.get(date);
  if (exception !== undefined) {
    return { intervals: exception, source: "exception" };
  }
  const weekday = isoWeekday(date);
  return {
    intervals: weekly
      .filter((interval) => interval.weekday === weekday)
      .map((interval) => ({ startMinute: interval.startMinute, endMinute: interval.endMinute }))
      .sort(byStart),
    source: "weekly",
  };
};

export const loadDaySchedule = async (db: Tx, date: LocalDate): Promise<DaySchedule> =>
  dayScheduleOf(date, await loadWeekly(db), await loadExceptions(db, { from: date, to: date }));

export const replaceWeekly = async (tx: Tx, intervals: WeeklyInterval[]): Promise<void> => {
  await tx.weeklyScheduleInterval.deleteMany({});
  if (intervals.length > 0) {
    await tx.weeklyScheduleInterval.createMany({ data: intervals });
  }
};

export const putException = async (tx: Tx, date: LocalDate, intervals: MinuteInterval[]): Promise<void> => {
  const day = localDateToDb(date);
  await tx.scheduleException.upsert({ where: { date: day }, create: { date: day }, update: { updatedAt: new Date() } });
  await tx.scheduleExceptionInterval.deleteMany({ where: { date: day } });
  if (intervals.length > 0) {
    await tx.scheduleExceptionInterval.createMany({ data: intervals.map((interval) => ({ date: day, ...interval })) });
  }
};

/** false when there was no exception for the date. */
export const deleteException = async (tx: Tx, date: LocalDate): Promise<boolean> => {
  const result = await tx.scheduleException.deleteMany({ where: { date: localDateToDb(date) } });
  return result.count > 0;
};

export type ActiveBookingTime = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  blockedUntil: Date;
  serviceName: string;
};

/**
 * Confirmed bookings overlapping [from, to) (to open-ended when omitted).
 * The schedule reads them to refuse changes that would invalidate a booking;
 * availability reads only their times.
 */
export const activeBookingTimes = (
  db: Tx,
  range: { from: Date; to?: Date; excludeBookingId?: string },
): Promise<ActiveBookingTime[]> =>
  db.booking.findMany({
    where: {
      status: "confirmed",
      blockedUntil: { gt: range.from },
      ...(range.to === undefined ? {} : { startsAt: { lt: range.to } }),
      ...(range.excludeBookingId === undefined ? {} : { id: { not: range.excludeBookingId } }),
    },
    select: { id: true, startsAt: true, endsAt: true, blockedUntil: true, serviceName: true },
    orderBy: { startsAt: "asc" },
  });
