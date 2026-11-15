import type { PrismaClient, ScheduleBlock, UserProfile } from "../../generated/prisma/client.js";
import { AppError } from "../../shared/errors/app-error.js";
import { idempotencyKeyReused } from "../../shared/http/idempotency-key.js";
import type { BookingRules } from "./booking-rules.js";
import type { CalendarTransaction, Tx } from "./calendar-transaction.js";
import type { CreateBlockRequest, LocalDateTime, UpdateBlockRequest } from "./schedule-block.schema.js";
import { activeBookingTimes, loadBlocks } from "./schedule.repository.js";
import type { ScheduleConflict } from "./schedule.service.js";
import {
  addDays,
  daysBetween,
  localDateTimeOf,
  localDateTimeToInstant,
  minutesToMs,
  resolveLocalDateTime,
  type LocalDate,
} from "./zoned-time.js";

/** Shortest block, real time. */
export const BLOCK_MIN_MINUTES = 15;
/** A block may start up to the end of the local day today + this. */
export const BLOCK_HORIZON_DAYS = 365;

export type BlockWriteResult = { block: ScheduleBlock; changed: boolean };

export type ScheduleBlockService = ReturnType<typeof createScheduleBlockService>;

export const blockNotFound = () => new AppError(404, "Schedule block not found", { code: "BLOCK_NOT_FOUND" });

const invalid = (field: "start" | "end", message: string) =>
  new AppError(400, "Validation failed", { code: "VALIDATION_FAILED", details: { errors: [{ field: [field], message }] } });

/**
 * Manual blocks of the calendar (admin): time kept out of booking on top of
 * the schedule, e.g. a personal appointment. A block occupies its time plus
 * one break on each side, like a booking: a session must end a break before
 * it, and the next session starts a break after it. Blocks may overlap each
 * other. Every write runs in the calendar transaction (the advisory lock of
 * bookings), so a booking and a block can never both take the same time;
 * a write that would touch a confirmed booking (its time or break) is
 * refused with 409 BLOCK_CONFLICT listing those bookings. Blocks create no
 * outbox events and no emails.
 */
export const createScheduleBlockService = ({
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
  const breakMs = minutesToMs(rules.breakMinutes);

  const instantOf = (field: "start" | "end", local: LocalDateTime): Date => {
    const resolved = resolveLocalDateTime(local.date, local.minuteOfDay, rules.timeZone);
    if (resolved.kind === "nonexistent") {
      throw invalid(field, "this local time does not exist on that date (change to summer time)");
    }
    if (resolved.kind === "ambiguous") {
      throw invalid(field, "this local time occurs twice on that date (change to winter time); choose another time");
    }
    return resolved.instant;
  };

  const localOf = (instant: Date): LocalDateTime => {
    const local = localDateTimeOf(instant, rules.timeZone);
    return { date: local.date, minuteOfDay: local.minuteOfDay };
  };

  /**
   * Instants of a block's bounds, checked as they will be stored: both on
   * one local date (the end at the latest at its midnight, 24:00, which is
   * the next date at 00:00), at least 15 minutes of real time, the end still
   * to come, the start at most today + 365 (local dates). A past block can
   * only be read or deleted.
   */
  const spanOf = (start: LocalDateTime, end: LocalDateTime): { startsAt: Date; endsAt: Date } => {
    const startsAt = instantOf("start", start);
    const endsAt = instantOf("end", end);
    const endOfDay = end.date === addDays(start.date, 1) && end.minuteOfDay === 0;
    if (end.date !== start.date && !endOfDay) {
      throw invalid("end", "must be on the date of start, 24:00 at the latest");
    }
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw invalid("end", "must be after start");
    }
    if (endsAt.getTime() - startsAt.getTime() < minutesToMs(BLOCK_MIN_MINUTES)) {
      throw invalid("end", `a block lasts at least ${String(BLOCK_MIN_MINUTES)} minutes`);
    }
    if (endsAt.getTime() <= now().getTime()) {
      throw invalid("end", "must be in the future");
    }
    const today = localDateTimeOf(now(), rules.timeZone).date;
    if (daysBetween(start.date, addDays(today, BLOCK_HORIZON_DAYS)) < 0) {
      throw invalid("start", `at most ${String(BLOCK_HORIZON_DAYS)} days ahead`);
    }
    return { startsAt, endsAt };
  };

  /** Confirmed bookings whose time or break overlaps the block or its breaks. */
  const conflictsWith = async (tx: Tx, span: { startsAt: Date; endsAt: Date }): Promise<ScheduleConflict[]> =>
    (await activeBookingTimes(tx, { from: span.startsAt, to: new Date(span.endsAt.getTime() + breakMs) })).map((booking) => ({
      bookingId: booking.id,
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      serviceName: booking.serviceName,
    }));

  const refuseIfConflicts = async (tx: Tx, span: { startsAt: Date; endsAt: Date }): Promise<void> => {
    const conflicts = await conflictsWith(tx, span);
    if (conflicts.length > 0) {
      throw new AppError(409, "The block would overlap confirmed bookings or their breaks; resolve them first", {
        code: "BLOCK_CONFLICT",
        details: { conflicts },
      });
    }
  };

  /**
   * Creates a block. Idempotent per (admin, Idempotency-Key): a repeat with
   * the same request returns the block as it is now (changed: false); the
   * same key with another request is refused (422 IDEMPOTENCY_KEY_REUSED);
   * a repeat after the block was deleted is refused (410 BLOCK_DELETED) and
   * never creates it again: the key record outlives the block.
   */
  const create = (admin: UserProfile, request: CreateBlockRequest, idempotencyKey: string): Promise<BlockWriteResult> => {
    const fingerprint = JSON.stringify([request.title, request.note, request.start, request.end]);
    return calendar(async (tx) => {
      const previous = await tx.scheduleBlockRequest.findUnique({
        where: { adminProfileId_idempotencyKey: { adminProfileId: admin.id, idempotencyKey } },
        include: { block: true },
      });
      if (previous !== null) {
        if (previous.requestFingerprint !== fingerprint) {
          throw idempotencyKeyReused();
        }
        if (previous.block === null) {
          throw new AppError(410, "The block created by this request has been deleted", { code: "BLOCK_DELETED" });
        }
        return { block: previous.block, changed: false };
      }

      const span = spanOf(request.start, request.end);
      await refuseIfConflicts(tx, span);
      const current = now();
      const block = await tx.scheduleBlock.create({
        data: {
          title: request.title,
          note: request.note,
          ...span,
          createdByProfileId: admin.id,
          createdAt: current,
          updatedAt: current,
        },
      });
      await tx.scheduleBlockRequest.create({
        data: { adminProfileId: admin.id, idempotencyKey, requestFingerprint: fingerprint, blockId: block.id, createdAt: current },
      });
      return { block, changed: true };
    });
  };

  /**
   * Changes some fields of a block. The resulting bounds are checked like a
   * new block on every change, also of the title or note only, so a past
   * block cannot be changed (only read or deleted); moved bounds are also
   * checked against confirmed bookings. Repeating a request leaves the block
   * as it is (`changed: false` when nothing differs).
   */
  const update = (id: string, request: UpdateBlockRequest): Promise<BlockWriteResult> =>
    calendar(async (tx) => {
      const block = await tx.scheduleBlock.findUnique({ where: { id } });
      if (block === null) {
        throw blockNotFound();
      }
      const span = spanOf(request.start ?? localOf(block.startsAt), request.end ?? localOf(block.endsAt));
      const title = request.title ?? block.title;
      const note = request.note === undefined ? block.note : request.note;
      const moved = span.startsAt.getTime() !== block.startsAt.getTime() || span.endsAt.getTime() !== block.endsAt.getTime();
      if (!moved && title === block.title && note === block.note) {
        return { block, changed: false };
      }
      if (moved) {
        await refuseIfConflicts(tx, span);
      }
      const updated = await tx.scheduleBlock.update({
        where: { id },
        data: { title, note, ...span, updatedAt: now() },
      });
      return { block: updated, changed: true };
    });

  /** Deletes a block for good; false when there was none. Its time is free again at once. */
  const remove = (id: string): Promise<boolean> =>
    calendar(async (tx) => (await tx.scheduleBlock.deleteMany({ where: { id } })).count > 0);

  const get = async (id: string): Promise<ScheduleBlock> => {
    const block = await prisma.scheduleBlock.findUnique({ where: { id } });
    if (block === null) {
      throw blockNotFound();
    }
    return block;
  };

  /** Blocks overlapping the local dates from–to (inclusive), by start. */
  const list = (range: { from: LocalDate; to: LocalDate }): Promise<ScheduleBlock[]> =>
    loadBlocks(prisma, {
      from: localDateTimeToInstant(range.from, 0, rules.timeZone),
      to: localDateTimeToInstant(addDays(range.to, 1), 0, rules.timeZone),
    });

  return { create, update, remove, get, list };
};
