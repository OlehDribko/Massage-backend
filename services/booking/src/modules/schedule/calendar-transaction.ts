import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { postgresErrorCode, prismaErrorCode } from "../../shared/database/errors.js";
import { AppError } from "../../shared/errors/app-error.js";

export { postgresErrorCode, prismaErrorCode } from "../../shared/database/errors.js";

export type Tx = Prisma.TransactionClient;

/**
 * Every change of the calendar (bookings, their times and status, the
 * schedule, deleting services) runs in a transaction holding one
 * transaction-level PostgreSQL advisory lock. The lock lives in the database,
 * so it serialises writers across all processes and instances of the API,
 * not only inside one Node process. Reads after acquiring it see everything
 * committed by earlier holders (READ COMMITTED, statement snapshots).
 *
 * One masseuse means low write volume, so one global lock is simple and
 * sufficient. The exclusion constraint "Booking_no_overlap" remains the last
 * line of defence for every writer.
 */
/** Also taken by catalogue data migrations (prisma/templates/catalog-data-migration.sql). */
export const CALENDAR_LOCK_KEY = 7_316_442_001;

export const LOCK_TIMEOUT_MS = 5_000;

export type CalendarTransaction = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

const calendarBusy = () =>
  new AppError(503, "The calendar is busy; retry shortly", {
    code: "CALENDAR_BUSY",
    details: { retryAfterSeconds: 2 },
  });

export const createCalendarTransaction = (prisma: PrismaClient): CalendarTransaction => {
  return async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${LOCK_TIMEOUT_MS}ms`}, true)`;
          await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${CALENDAR_LOCK_KEY}::bigint)`;
          return work(tx);
        },
        { maxWait: LOCK_TIMEOUT_MS, timeout: 3 * LOCK_TIMEOUT_MS },
      );
    } catch (error) {
      // 55P03 lock_not_available; P2028: Prisma transaction API timeout.
      if (postgresErrorCode(error) === "55P03" || prismaErrorCode(error) === "P2028") {
        throw calendarBusy();
      }
      throw error;
    }
  };
};
