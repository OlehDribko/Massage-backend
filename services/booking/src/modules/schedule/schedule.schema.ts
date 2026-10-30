import { z } from "zod";
import { hasOverlap, type MinuteInterval } from "./slots.js";

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
