import { z } from "zod";

/**
 * Local dates and wall-clock times in an IANA time zone, converted to and
 * from absolute instants with the runtime's time zone database (Intl, full
 * ICU in Node). No fixed UTC offsets: the offset is looked up for every
 * instant, so daylight saving transitions are handled.
 */

/** A calendar date in the studio time zone, "YYYY-MM-DD". */
export type LocalDate = string;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const dateFields = (date: LocalDate): { year: number; month: number; day: number } => {
  const match = LOCAL_DATE.exec(date);
  if (match === null) {
    throw new Error(`not a local date: ${date}`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
};

const isRealDate = (value: string): boolean => {
  const match = LOCAL_DATE.exec(value);
  if (match === null) {
    return false;
  }
  const { year, month, day } = dateFields(value);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
};

/** "YYYY-MM-DD" that exists in the calendar (rejects 2027-02-30). */
export const localDateSchema = z
  .string()
  .refine(isRealDate, { message: "must be a calendar date YYYY-MM-DD" });

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const wallClockAt = (instantMs: number, timeZone: string): WallClock => {
  const fields: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    switch (part.type) {
      case "year":
      case "month":
      case "day":
      case "hour":
      case "minute":
      case "second":
        fields[part.type] = Number(part.value);
        break;
      default:
        break;
    }
  }
  return fields;
};

/** UTC offset (minutes, east positive) of the time zone at an instant. */
export const offsetMinutesAt = (instantMs: number, timeZone: string): number => {
  const wholeSecond = Math.floor(instantMs / 1000) * 1000;
  const wall = wallClockAt(wholeSecond, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((asUtc - wholeSecond) / MINUTE_MS);
};

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** Local date and minute of the day of an instant. */
export const localDateTimeOf = (
  instant: Date,
  timeZone: string,
): { date: LocalDate; minuteOfDay: number } => {
  const wall = wallClockAt(instant.getTime(), timeZone);
  return {
    date: `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`,
    minuteOfDay: wall.hour * 60 + wall.minute,
  };
};

/**
 * The instant of a local date and minute of the day (0–1440; 1440 is the next
 * midnight). Daylight saving transitions, like Temporal's "compatible" mode:
 * - a time that occurs twice (autumn) maps to the earlier instant;
 * - a time that does not exist (spring gap) maps forward by the gap's length
 *   (02:30 on the spring-forward day in Paris → 03:30 summer time).
 */
export const localDateTimeToInstant = (date: LocalDate, minuteOfDay: number, timeZone: string): Date => {
  const { year, month, day } = dateFields(date);
  const wall = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  const offsetBefore = offsetMinutesAt(wall - DAY_MS, timeZone);
  const offsetAfter = offsetMinutesAt(wall + DAY_MS, timeZone);

  const valid = [...new Set([offsetBefore, offsetAfter])]
    .map((offset) => wall - offset * MINUTE_MS)
    .filter((candidate) => offsetMinutesAt(candidate, timeZone) * MINUTE_MS === wall - candidate);

  if (valid.length > 0) {
    return new Date(Math.min(...valid));
  }
  // In the gap: interpret with the offset in force before the transition.
  return new Date(wall - offsetBefore * MINUTE_MS);
};

export const addDays = (date: LocalDate, days: number): LocalDate => {
  const { year, month, day } = dateFields(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

/** ISO weekday of a local date: 1 = Monday … 7 = Sunday. */
export const isoWeekday = (date: LocalDate): number => {
  const { year, month, day } = dateFields(date);
  const sundayFirst = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sundayFirst === 0 ? 7 : sundayFirst;
};

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: LocalDate, to: LocalDate): number => {
  const a = dateFields(from);
  const b = dateFields(to);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS,
  );
};

/** PostgreSQL DATE columns arrive as UTC midnight. */
export const localDateFromDb = (value: Date): LocalDate => value.toISOString().slice(0, 10);

export const localDateToDb = (date: LocalDate): Date => {
  const { year, month, day } = dateFields(date);
  return new Date(Date.UTC(year, month - 1, day));
};

export const minutesToMs = (minutes: number): number => minutes * MINUTE_MS;
