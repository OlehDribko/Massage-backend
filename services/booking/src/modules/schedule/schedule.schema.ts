import { z } from "zod";
import { hasOverlap, type MinuteInterval } from "./slots.js";
import { daysBetween, localDateSchema, type LocalDate } from "./zoned-time.js";

const HH_MM = /^(?:([01]\d|2[0-3]):([0-5]\d)|(24):(00))$/;

/** "HH:MM" local time (00:00–24:00) → minutes since local midnight. */
export const localTimeSchema = z
  .string()
  .regex(HH_MM, { message: "must be a local time HH:MM (00:00–24:00)" })
  .transform((value) => {
    const [hours = "0", minutes = "0"] = value.split(":");
    return Number(hours) * 60 + Number(minutes);
  });

export const formatLocalTime = (minuteOfDay: number): string =>
  `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;

const MAX_INTERVALS_PER_DAY = 6;

const intervalSchema = z
  .object({ start: localTimeSchema, end: localTimeSchema })
  .strict()
  .refine((interval) => interval.start < interval.end, { message: "start must be before end", path: ["end"] })
  .transform((interval): MinuteInterval => ({ startMinute: interval.start, endMinute: interval.end }));

const noOverlap = (intervals: MinuteInterval[]): boolean => !hasOverlap(intervals);

const weeklyIntervalSchema = z
  .object({ weekday: z.int().min(1).max(7), start: localTimeSchema, end: localTimeSchema })
  .strict()
  .refine((interval) => interval.start < interval.end, { message: "start must be before end", path: ["end"] });

export type WeeklyInterval = MinuteInterval & { weekday: number };

/** The whole weekly schedule, replaced at once. Weekdays: 1 = Monday … 7 = Sunday. */
export const weeklyScheduleSchema = z
  .object({ intervals: z.array(weeklyIntervalSchema).max(7 * MAX_INTERVALS_PER_DAY) })
  .strict()
  .transform((body): WeeklyInterval[] =>
    body.intervals.map((interval) => ({
      weekday: interval.weekday,
      startMinute: interval.start,
      endMinute: interval.end,
    })),
  )
  .refine(
    (intervals) =>
      [1, 2, 3, 4, 5, 6, 7].every((weekday) => {
        const day = intervals.filter((interval) => interval.weekday === weekday);
        return day.length <= MAX_INTERVALS_PER_DAY && noOverlap(day);
      }),
    { message: `intervals of one weekday must not overlap (at most ${MAX_INTERVALS_PER_DAY} per day)`, path: ["intervals"] },
  );

/** One date: `{ "closed": true }` (day off) or its own working intervals. */
export const scheduleExceptionSchema = z
  .union([
    z.object({ closed: z.literal(true) }).strict(),
    z
      .object({ intervals: z.array(intervalSchema).min(1).max(MAX_INTERVALS_PER_DAY) })
      .strict()
      .refine((body) => noOverlap(body.intervals), { message: "intervals must not overlap", path: ["intervals"] }),
  ])
  .transform((body): MinuteInterval[] => ("intervals" in body ? body.intervals : []));

/** At most this many dates in one change or one view: a whole month (or a week) with room to spare. */
export const MAX_DAYS_PER_REQUEST = 62;

/** One date of a multi-date change: own intervals ([] = day off) or back to the weekly rule. */
export type DayChange = { date: LocalDate; kind: "exception"; intervals: MinuteInterval[] } | { date: LocalDate; kind: "weekly" };

const dayChangeSchema = z
  .union([
    z.object({ date: localDateSchema, closed: z.literal(true) }).strict(),
    z
      .object({ date: localDateSchema, intervals: z.array(intervalSchema).min(1).max(MAX_INTERVALS_PER_DAY) })
      .strict()
      .refine((body) => noOverlap(body.intervals), { message: "intervals must not overlap", path: ["intervals"] }),
    z.object({ date: localDateSchema, useWeekly: z.literal(true) }).strict(),
  ])
  .transform((day): DayChange => {
    if ("intervals" in day) {
      return { date: day.date, kind: "exception", intervals: day.intervals };
    }
    if ("closed" in day) {
      return { date: day.date, kind: "exception", intervals: [] };
    }
    return { date: day.date, kind: "weekly" };
  });

/**
 * Several dates at once (a week, a month): each `{ "date", "closed": true }`,
 * `{ "date", "intervals": [...] }` or `{ "date", "useWeekly": true }`. Each date at most once.
 */
export const scheduleDaysSchema = z
  .object({ days: z.array(dayChangeSchema).min(1).max(MAX_DAYS_PER_REQUEST) })
  .strict()
  .refine((body) => new Set(body.days.map((day) => day.date)).size === body.days.length, {
    message: "each date at most once",
    path: ["days"],
  })
  .transform((body) => body.days);

/** `from`–`to` (inclusive) of a day view: both required, at most MAX_DAYS_PER_REQUEST dates. */
const spanOf = (range: { from: string; to: string }): number | undefined =>
  localDateSchema.safeParse(range.from).success && localDateSchema.safeParse(range.to).success
    ? daysBetween(range.from, range.to)
    : undefined;

export const dayRangeSchema = z
  .object({ from: localDateSchema, to: localDateSchema })
  .refine((range) => (spanOf(range) ?? 0) >= 0, { message: "to must not be before from", path: ["to"] })
  .refine((range) => (spanOf(range) ?? 0) < MAX_DAYS_PER_REQUEST, {
    message: `at most ${MAX_DAYS_PER_REQUEST} days`,
    path: ["to"],
  });
