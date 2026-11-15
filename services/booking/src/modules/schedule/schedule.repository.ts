import type { ScheduleBlock } from "../../generated/prisma/client.js";
import type { Tx } from "./calendar-transaction.js";
import type { WeeklyInterval } from "./schedule.schema.js";
import type { MinuteInterval, OccupiedTime } from "./slots.js";
import { isoWeekday, localDateFromDb, localDateToDb, minutesToMs, type LocalDate } from "./zoned-time.js";

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

/** Closed dates (ScheduleClosure) in a range → when each was closed. */
export const loadClosures = async (db: Tx, range: { from: LocalDate; to?: LocalDate }): Promise<Map<LocalDate, Date>> => {
  const rows = await db.scheduleClosure.findMany({
    where: {
      date: {
        gte: localDateToDb(range.from),
        ...(range.to === undefined ? {} : { lte: localDateToDb(range.to) }),
      },
    },
    orderBy: { date: "asc" },
  });
  return new Map(rows.map((row) => [localDateFromDb(row.date), row.createdAt]));
};

export const loadClosuresOf = async (db: Tx, dates: LocalDate[]): Promise<Map<LocalDate, Date>> => {
  const rows = await db.scheduleClosure.findMany({ where: { date: { in: dates.map(localDateToDb) } } });
  return new Map(rows.map((row) => [localDateFromDb(row.date), row.createdAt]));
};

/** Closes the dates; already closed dates keep their closure (and its time). */
export const putClosures = async (tx: Tx, dates: LocalDate[]): Promise<void> => {
  await tx.scheduleClosure.createMany({ data: dates.map((date) => ({ date: localDateToDb(date) })), skipDuplicates: true });
};

/** Removes the closures of the dates (only them: the schedule underneath is untouched). */
export const deleteClosures = async (tx: Tx, dates: LocalDate[]): Promise<void> => {
  await tx.scheduleClosure.deleteMany({ where: { date: { in: dates.map(localDateToDb) } } });
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

/**
 * Writes several dates at once with a fixed number of queries (the calendar
 * transaction has a short timeout): their old exceptions go, then the new ones
 * are inserted. Dates in `weekly` only lose their exception.
 */
export const putDays = async (
  tx: Tx,
  { exceptions, weekly }: { exceptions: Map<LocalDate, MinuteInterval[]>; weekly: LocalDate[] },
): Promise<void> => {
  const dates = [...exceptions.keys(), ...weekly].map(localDateToDb);
  await tx.scheduleException.deleteMany({ where: { date: { in: dates } } });
  if (exceptions.size === 0) {
    return;
  }
  await tx.scheduleException.createMany({ data: [...exceptions.keys()].map((date) => ({ date: localDateToDb(date) })) });
  const intervals = [...exceptions].flatMap(([date, list]) => list.map((interval) => ({ date: localDateToDb(date), ...interval })));
  if (intervals.length > 0) {
    await tx.scheduleExceptionInterval.createMany({ data: intervals });
  }
};

/** Blocks overlapping [from, to) (their own time, without breaks), by start. */
export const loadBlocks = (db: Tx, range: { from: Date; to: Date }): Promise<ScheduleBlock[]> =>
  db.scheduleBlock.findMany({
    where: { startsAt: { lt: range.to }, endsAt: { gt: range.from } },
    orderBy: [{ startsAt: "asc" }, { endsAt: "asc" }, { id: "asc" }],
  });

/**
 * Time kept by blocks for availability, overlapping [from, to): a block
 * [startsAt, endsAt) is occupied like a booking, with one break after it
 * (blockedUntil = endsAt + break). The break before it comes from the slot
 * rules: a session plus its break must end by the block's start. Overlapping
 * blocks simply merge.
 */
export const blockTimes = async (
  db: Tx,
  range: { from: Date; to: Date; breakMinutes: number },
): Promise<OccupiedTime[]> => {
  const breakMs = minutesToMs(range.breakMinutes);
  const blocks = await db.scheduleBlock.findMany({
    where: { startsAt: { lt: range.to }, endsAt: { gt: new Date(range.from.getTime() - breakMs) } },
    select: { startsAt: true, endsAt: true },
  });
  return blocks.map((block) => ({ startsAt: block.startsAt, blockedUntil: new Date(block.endsAt.getTime() + breakMs) }));
};
