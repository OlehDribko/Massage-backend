import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../shared/errors/app-error.js";

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
const CALENDAR_LOCK_KEY = 7_316_442_001;

export const LOCK_TIMEOUT_MS = 5_000;

export type CalendarTransaction = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

const calendarBusy = () =>
  new AppError(503, "The calendar is busy; retry shortly", {
    code: "CALENDAR_BUSY",
    details: { retryAfterSeconds: 2 },
  });

const PRISMA_CODE = /^P[1-9]\d{3}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;

const isSqlState = (value: unknown): value is string =>
  typeof value === "string" && SQLSTATE.test(value) && !PRISMA_CODE.test(value);

/** SQLSTATE of a PostgreSQL error wrapped by Prisma's driver adapter, if any. */
export const postgresErrorCode = (error: unknown, depth = 0): string | undefined => {
  if (typeof error !== "object" || error === null || depth > 6) {
    return undefined;
  }
  if ("originalCode" in error && isSqlState(error.originalCode)) {
    return error.originalCode;
  }
  if ("code" in error && isSqlState(error.code)) {
    return error.code;
  }
  const nested = [
    "cause" in error ? error.cause : undefined,
    "meta" in error ? error.meta : undefined,
    "driverAdapterError" in error ? error.driverAdapterError : undefined,
  ];
  for (const value of nested) {
    const found = postgresErrorCode(value, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

/** Prisma's own error code (P1xxx–P3xxx), if any. */
export const prismaErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && PRISMA_CODE.test(error.code)
    ? error.code
    : undefined;

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
