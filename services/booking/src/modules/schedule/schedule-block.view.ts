import type { ScheduleBlock } from "../../generated/prisma/client.js";
import { formatLocalTime } from "./schedule.schema.js";
import { localDateTimeOf } from "./zoned-time.js";

/** "YYYY-MM-DDTHH:MM" in the studio time zone (a block ending at midnight shows the next date at 00:00). */
const localDateTime = (instant: Date, timeZone: string): string => {
  const local = localDateTimeOf(instant, timeZone);
  return `${local.date}T${formatLocalTime(local.minuteOfDay)}`;
};

/** A block for the admin: local bounds as entered, and the same bounds as instants. */
export const toBlockView = (block: ScheduleBlock, timeZone: string) => ({
  id: block.id,
  title: block.title,
  note: block.note,
  start: localDateTime(block.startsAt, timeZone),
  end: localDateTime(block.endsAt, timeZone),
  startsAt: block.startsAt.toISOString(),
  endsAt: block.endsAt.toISOString(),
  createdAt: block.createdAt.toISOString(),
  updatedAt: block.updatedAt.toISOString(),
});
