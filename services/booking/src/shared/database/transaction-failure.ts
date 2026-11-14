import { z } from "zod";
import { postgresErrorCode, prismaErrorCode } from "./errors.js";

/**
 * Why an interactive transaction (`prisma.$transaction(async (tx) => …)`)
 * failed, when the reason is the transaction itself rather than the work in
 * it. Shapes confirmed with Prisma 7.10 and @prisma/adapter-pg on PostgreSQL 17:
 *
 * - `lock_not_available`: PostgreSQL 55P03 (`lock_timeout` while waiting for an
 *   advisory or row lock). Prisma wraps it as P2010 (raw query) or P2039
 *   (model query) with the SQLSTATE in `meta.driverAdapterError.cause`.
 * - `transaction_start_timeout`: P2028 "Unable to start a transaction in the
 *   given time." No connection within `maxWait` (all in use, or the database
 *   slow to accept one); nothing ran.
 * - `transaction_expired`: P2028 with `meta.operation` ("query" or "commit"),
 *   `meta.timeout` and `meta.timeTaken`: the work outlived `timeout`. Prisma
 *   rolls the transaction back and never commits it.
 * - `transaction_closed`: P2028 "Transaction already closed": the transaction
 *   client was used after commit or rollback (a programming error).
 * - `transaction_api_error`: any other P2028 (transaction not found, internal).
 *
 * In every case the transaction did not commit. Only the first two are waits
 * for something outside the transaction, so only they mean "busy, retry
 * shortly"; an expired transaction means the work itself was too slow, and a
 * repeat would most likely fail the same way.
 */
export type TransactionFailure =
  | "lock_not_available"
  | "transaction_start_timeout"
  | "transaction_expired"
  | "transaction_closed"
  | "transaction_api_error";

const expiredMetaSchema = z.object({
  operation: z.string(),
  timeout: z.number(),
  timeTaken: z.number(),
});

// Fixed texts of Prisma's transaction manager (no values in them). The full
// message also carries a prefix ("Transaction API error: ", or an
// "Invalid `…` invocation" block), so they are searched, not anchored.
const START_TIMEOUT_TEXT = "Unable to start a transaction in the given time";
const EXPIRED_TEXT = "cannot be executed on an expired transaction";
const CLOSED_TEXT = "Transaction already closed";

const metaOf = (error: object): unknown => ("meta" in error ? error.meta : undefined);

export const classifyTransactionFailure = (error: unknown): TransactionFailure | undefined => {
  if (postgresErrorCode(error) === "55P03") {
    return "lock_not_available";
  }
  if (typeof error !== "object" || error === null || prismaErrorCode(error) !== "P2028") {
    return undefined;
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes(START_TIMEOUT_TEXT)) {
    return "transaction_start_timeout";
  }
  if (expiredMetaSchema.safeParse(metaOf(error)).success || message.includes(EXPIRED_TEXT)) {
    return "transaction_expired";
  }
  if (message.includes(CLOSED_TEXT)) {
    return "transaction_closed";
  }
  return "transaction_api_error";
};

/**
 * The transaction waited too long for something outside it — a lock held by
 * another writer, or a connection (all in use, or the database slow to accept
 * one, e.g. while waking up) — and nothing was committed: the same request may
 * be sent again after a short wait.
 */
export const isRetryableTransactionFailure = (failure: TransactionFailure | undefined): boolean =>
  failure === "lock_not_available" || failure === "transaction_start_timeout";
