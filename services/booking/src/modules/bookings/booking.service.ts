import type { Booking, BookingTimeChange, Prisma, PrismaClient, UserProfile } from "../../generated/prisma/client.js";
import { AppError } from "../../shared/errors/app-error.js";
import { canCancelAppointment, canRescheduleAppointment } from "../access/policies.js";
import { serviceNotFound } from "../catalog/catalog.service.js";
import { checkStart, type UnavailableReason } from "../schedule/availability.js";
import type { BookingRules } from "../schedule/booking-rules.js";
import { postgresErrorCode, type CalendarTransaction, type Tx } from "../schedule/calendar-transaction.js";
import { addDays, localDateTimeToInstant, minutesToMs, type LocalDate } from "../schedule/zoned-time.js";
import { recordBookingEvent } from "./booking.events.js";
import { cancellationAllowed, rescheduleAllowed } from "./booking.rules.js";
import type { CreateBookingRequest } from "./booking.schema.js";

export type BookingWithHistory = Booking & { timeChanges: BookingTimeChange[] };
export type BookingWithClient = BookingWithHistory & { client: UserProfile };

const bookingNotFound = () => new AppError(404, "Booking not found", { code: "BOOKING_NOT_FOUND" });

const slotUnavailable = (reason: UnavailableReason) =>
  new AppError(409, "The requested time is not available", { code: "SLOT_UNAVAILABLE", details: { reason } });

const notActive = () =>
  new AppError(409, "The booking is cancelled", { code: "BOOKING_NOT_ACTIVE" });

/** Outcome of a write; `changed: false` = repeated request, nothing done, no new event. */
export type WriteResult = { booking: BookingWithClient; changed: boolean };

export type BookingService = ReturnType<typeof createBookingService>;

/**
 * Bookings. Every write runs in the calendar transaction (one PostgreSQL
 * advisory lock for all processes): availability is checked and the change
 * written atomically, and the outbox event is written in the same
 * transaction. Price, duration and end are always computed here from the
 * service, never taken from the request.
 */
export const createBookingService = ({
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
  const withHistory = {
    timeChanges: { orderBy: { changedAt: "asc" } },
    client: true,
  } satisfies Prisma.BookingInclude;

  const load = (db: Tx, id: string): Promise<BookingWithClient | null> =>
    db.booking.findUnique({ where: { id }, include: withHistory });

  /** The caller's own booking; someone else's is reported as not found. */
  const loadOwn = async (db: Tx, actor: UserProfile, id: string): Promise<BookingWithClient> => {
    const booking = await load(db, id);
    if (booking === null || booking.clientProfileId !== actor.id) {
      throw bookingNotFound();
    }
    return booking;
  };

  const occupiedUntil = (endsAt: Date): Date => new Date(endsAt.getTime() + minutesToMs(rules.breakMinutes));

  /** The overlap constraint fired: only possible if a writer bypassed the lock. */
  const mapOverlap = (error: unknown): never => {
    if (postgresErrorCode(error) === "23P01") {
      throw slotUnavailable("taken");
    }
    throw error;
  };

  /**
   * Creates a confirmed booking. Idempotent per (client, Idempotency-Key):
   * a repeat with the same key and the same request returns the booking it
   * created (changed: false) without a second booking or event; the same key
   * with a different request is refused.
   */
  const create = (
    client: UserProfile,
    request: CreateBookingRequest,
    idempotencyKey: string,
  ): Promise<WriteResult> => {
    const fingerprint = `${request.serviceId}|${request.startsAt.toISOString()}`;
    return calendar(async (tx) => {
      const previous = await tx.booking.findUnique({
        where: { clientProfileId_idempotencyKey: { clientProfileId: client.id, idempotencyKey } },
        include: withHistory,
      });
      if (previous !== null) {
        if (previous.requestFingerprint !== fingerprint) {
          throw new AppError(422, "This Idempotency-Key was already used for a different request", {
            code: "IDEMPOTENCY_KEY_REUSED",
          });
        }
        return { booking: previous, changed: false };
      }

      const service = await tx.service.findUnique({ where: { id: request.serviceId } });
      if (service === null) {
        throw serviceNotFound();
      }
      if (service.archivedAt !== null) {
        throw new AppError(409, "This service is no longer available for booking", { code: "SERVICE_NOT_BOOKABLE" });
      }

      const current = now();
      const check = await checkStart(tx, {
        startsAt: request.startsAt,
        durationMinutes: service.durationMinutes,
        now: current,
        rules,
      });
      if (!check.ok) {
        throw slotUnavailable(check.reason);
      }

      const endsAt = new Date(request.startsAt.getTime() + minutesToMs(service.durationMinutes));
      const created = await tx.booking
        .create({
          data: {
            clientProfileId: client.id,
            serviceId: service.id,
            serviceName: service.name,
            durationMinutes: service.durationMinutes,
            priceCents: service.priceCents,
            currency: service.currency,
            startsAt: request.startsAt,
            endsAt,
            blockedUntil: occupiedUntil(endsAt),
            idempotencyKey,
            requestFingerprint: fingerprint,
            createdAt: current,
          },
          include: withHistory,
        })
        .catch(mapOverlap);

      await recordBookingEvent(tx, {
        type: "booking.created",
        dedupeKey: `booking.created:${created.id}`,
        booking: created,
        client,
        actor: client,
        timeZone: rules.timeZone,
        occurredAt: current,
      });
      return { booking: created, changed: true };
    });
  };

  /**
   * Moves the caller's own active booking to a new start, keeping its
   * service, agreed price and duration. Atomic: if the new time is not
   * available the booking stays as it was. Repeating a successful request
   * (the booking already starts at the requested time) changes nothing.
   */
  const reschedule = (client: UserProfile, id: string, startsAt: Date): Promise<WriteResult> =>
    calendar(async (tx) => {
      const booking = await loadOwn(tx, client, id);
      if (!canRescheduleAppointment(client, booking)) {
        throw bookingNotFound();
      }
      if (booking.status !== "confirmed") {
        throw notActive();
      }
      if (booking.startsAt.getTime() === startsAt.getTime()) {
        return { booking, changed: false };
      }
      const current = now();
      if (!rescheduleAllowed(booking.startsAt, current, rules)) {
        throw new AppError(409, "A booking can be moved only while more than 12 hours remain before it", {
          code: "RESCHEDULE_WINDOW_CLOSED",
        });
      }
      const check = await checkStart(tx, {
        startsAt,
        durationMinutes: booking.durationMinutes,
        excludeBookingId: booking.id,
        now: current,
        rules,
      });
      if (!check.ok) {
        throw slotUnavailable(check.reason);
      }

      const endsAt = new Date(startsAt.getTime() + minutesToMs(booking.durationMinutes));
      const change = await tx.bookingTimeChange.create({
        data: {
          bookingId: booking.id,
          previousStartsAt: booking.startsAt,
          previousEndsAt: booking.endsAt,
          newStartsAt: startsAt,
          newEndsAt: endsAt,
          changedByProfileId: client.id,
          changedAt: current,
        },
      });
      const updated = await tx.booking
        .update({
          where: { id: booking.id },
          data: { startsAt, endsAt, blockedUntil: occupiedUntil(endsAt) },
          include: withHistory,
        })
        .catch(mapOverlap);

      await recordBookingEvent(tx, {
        type: "booking.rescheduled",
        dedupeKey: `booking.rescheduled:${change.id}`,
        booking: updated,
        client: updated.client,
        actor: client,
        timeZone: rules.timeZone,
        occurredAt: current,
        previous: { startsAt: booking.startsAt.toISOString(), endsAt: booking.endsAt.toISOString() },
      });
      return { booking: updated, changed: true };
    });

  const cancel = async (
    actor: UserProfile,
    booking: BookingWithClient,
    tx: Tx,
    by: "client" | "admin",
    reason: string | null,
  ): Promise<WriteResult> => {
    // Already cancelled (by anyone): a repeat changes nothing and adds no event.
    if (booking.status === "cancelled") {
      return { booking, changed: false };
    }
    const current = now();
    if (!cancellationAllowed(booking.startsAt, current)) {
      throw new AppError(409, "A booking can be cancelled only before it starts", {
        code: "CANCELLATION_WINDOW_CLOSED",
      });
    }
    const updated = await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: "cancelled",
        cancelledAt: current,
        cancelledBy: by,
        cancelledByProfileId: actor.id,
        cancellationReason: reason,
      },
      include: withHistory,
    });
    await recordBookingEvent(tx, {
      type: "booking.cancelled",
      dedupeKey: `booking.cancelled:${booking.id}`,
      booking: updated,
      client: updated.client,
      actor,
      timeZone: rules.timeZone,
      occurredAt: current,
    });
    return { booking: updated, changed: true };
  };

  /** The client cancels their own booking, any time before it starts. */
  const cancelOwn = (client: UserProfile, id: string): Promise<WriteResult> =>
    calendar(async (tx) => {
      const booking = await loadOwn(tx, client, id);
      if (!canCancelAppointment(client, booking)) {
        throw bookingNotFound();
      }
      return cancel(client, booking, tx, "client", null);
    });

  /** An admin cancels a future booking; the reason is optional. */
  const cancelByAdmin = (admin: UserProfile, id: string, reason: string | null): Promise<WriteResult> =>
    calendar(async (tx) => {
      const booking = await load(tx, id);
      if (booking === null || !canCancelAppointment(admin, booking)) {
        throw bookingNotFound();
      }
      return cancel(admin, booking, tx, "admin", reason);
    });

  const listOwn = (client: UserProfile): Promise<BookingWithClient[]> =>
    prisma.booking.findMany({
      where: { clientProfileId: client.id },
      include: withHistory,
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });

  const getOwn = (client: UserProfile, id: string): Promise<BookingWithClient> => loadOwn(prisma, client, id);

  /** Admin: bookings starting on a local date (all statuses). */
  const listForDate = (date: LocalDate): Promise<BookingWithClient[]> =>
    prisma.booking.findMany({
      where: {
        startsAt: {
          gte: localDateTimeToInstant(date, 0, rules.timeZone),
          lt: localDateTimeToInstant(addDays(date, 1), 0, rules.timeZone),
        },
      },
      include: withHistory,
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });

  const getAny = async (id: string): Promise<BookingWithClient> => {
    const booking = await load(prisma, id);
    if (booking === null) {
      throw bookingNotFound();
    }
    return booking;
  };

  return { create, reschedule, cancelOwn, cancelByAdmin, listOwn, getOwn, listForDate, getAny };
};
