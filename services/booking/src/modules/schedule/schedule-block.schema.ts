import { z } from "zod";
import { addDays, localDateSchema, type LocalDate } from "./zoned-time.js";

/** A wall-clock moment in the studio time zone: a local date and minutes since its midnight (0–1439). */
export type LocalDateTime = { date: LocalDate; minuteOfDay: number };

export const BLOCK_TITLE_MAX_LENGTH = 100;
export const BLOCK_NOTE_MAX_LENGTH = 500;
/** Block bounds lie on this grid of local minutes. */
export const BLOCK_STEP_MINUTES = 5;

const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;

/**
 * "YYYY-MM-DDTHH:MM", local time of the studio, no offset, on the 5-minute
 * grid. With `allowEndOfDay`, "T24:00" is the next midnight (it is returned
 * as the next date at 00:00).
 */
const localDateTimeSchema = (allowEndOfDay: boolean) =>
  z
    .string()
    .regex(LOCAL_DATE_TIME, { message: "must be a local date and time YYYY-MM-DDTHH:MM (no offset)" })
    .transform((value, ctx): LocalDateTime => {
      const [, date = "", hours = "", minutes = ""] = LOCAL_DATE_TIME.exec(value) ?? [];
      const hour = Number(hours);
      const minute = Number(minutes);
      if (!localDateSchema.safeParse(date).success) {
        ctx.addIssue({ code: "custom", message: "must be a calendar date YYYY-MM-DD" });
        return z.NEVER;
      }
      const endOfDay = allowEndOfDay && hour === 24 && minute === 0;
      if (!endOfDay && (hour > 23 || minute > 59)) {
        ctx.addIssue({ code: "custom", message: allowEndOfDay ? "time must be 00:00–24:00" : "time must be 00:00–23:59" });
        return z.NEVER;
      }
      if (minute % BLOCK_STEP_MINUTES !== 0) {
        ctx.addIssue({ code: "custom", message: `minutes must be a multiple of ${String(BLOCK_STEP_MINUTES)}` });
        return z.NEVER;
      }
      return endOfDay ? { date: addDays(date, 1), minuteOfDay: 0 } : { date, minuteOfDay: hour * 60 + minute };
    });

const titleSchema = z.string().trim().min(1).max(BLOCK_TITLE_MAX_LENGTH);
/** Optional; empty (or only spaces) is stored as no note. */
const noteSchema = z
  .string()
  .trim()
  .max(BLOCK_NOTE_MAX_LENGTH)
  .nullable()
  .transform((value) => (value === null || value === "" ? null : value));

export type CreateBlockRequest = { title: string; note: string | null; start: LocalDateTime; end: LocalDateTime };

export const createBlockSchema = z
  .object({
    title: titleSchema,
    note: noteSchema.optional(),
    start: localDateTimeSchema(false),
    end: localDateTimeSchema(true),
  })
  .strict()
  .transform((body): CreateBlockRequest => ({ title: body.title, note: body.note ?? null, start: body.start, end: body.end }));

export type UpdateBlockRequest = {
  title?: string;
  /** null removes the note. */
  note?: string | null;
  start?: LocalDateTime;
  end?: LocalDateTime;
};

/** Any of the fields; the others keep their values. */
export const updateBlockSchema = z
  .object({
    title: titleSchema.optional(),
    note: noteSchema.optional(),
    start: localDateTimeSchema(false).optional(),
    end: localDateTimeSchema(true).optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), { message: "at least one field is required" })
  .transform((body): UpdateBlockRequest => {
    const update: UpdateBlockRequest = {};
    if (body.title !== undefined) {
      update.title = body.title;
    }
    if (body.note !== undefined) {
      update.note = body.note;
    }
    if (body.start !== undefined) {
      update.start = body.start;
    }
    if (body.end !== undefined) {
      update.end = body.end;
    }
    return update;
  });

export const blockIdSchema = z.uuid();
