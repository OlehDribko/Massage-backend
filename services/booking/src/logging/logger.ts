import { pino } from "pino";
import type { DestinationStream, Logger, LevelWithSilent } from "pino";
import { postgresErrorCode } from "../shared/database/errors.js";
import { classifyTransactionFailure, type TransactionFailure } from "../shared/database/transaction-failure.js";

export type { Logger };

export type LoggerOptions = {
  level: LevelWithSilent;
  appVersion?: string | undefined;
};

/**
 * JSON logs to stdout (or the given destination, used by tests).
 * No hostname/pid in the base fields; nothing from the request or config is
 * attached automatically — callers log explicit, safe fields only.
 */
export const createLogger = (
  options: LoggerOptions,
  destination?: DestinationStream,
): Logger => {
  const pinoOptions = {
    level: options.level,
    base: {
      service: "booking",
      ...(options.appVersion !== undefined ? { version: options.appVersion } : {}),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };

  // stdout is written synchronously. pino's default asynchronous destination
  // flushes buffered lines synchronously on process.exit() while an earlier
  // write may still be in flight in the libuv threadpool, so the last lines
  // before exit (shutdown, fatal errors) could be reordered or lost.
  return pino(pinoOptions, destination ?? pino.destination({ dest: 1, sync: true }));
};

export type SafeErrorLog = {
  type: string;
  code?: string;
  /** SQLSTATE found inside a wrapped driver error (e.g. 55P03 under Prisma's P2010). */
  sqlState?: string;
  /** Why an interactive transaction failed, from fixed codes and texts. */
  transactionFailure?: TransactionFailure;
  stack?: string;
  /** The original failure behind this one (`Error.cause`), described the same way. */
  cause?: SafeErrorLog;
};

const MAX_CAUSE_DEPTH = 3;

// Node/driver codes (EADDRINUSE, P2002) and PostgreSQL SQLSTATE (42501).
const SAFE_CODE = /^(?:[A-Z][A-Z0-9_]{0,39}|[0-9A-Z]{5})$/;

/**
 * Describes an error for logs without its message: provider and driver errors
 * (Brevo, Prisma, pg) may embed connection strings, emails or keys in messages.
 * Keeps the class name, a short machine code (e.g. EADDRINUSE, P2002, SQLSTATE),
 * a SQLSTATE wrapped inside, the kind of transaction failure, stack frames
 * without the first (message) line, and the same for `cause` (a few levels).
 */
const describe = (error: unknown, depth: number): SafeErrorLog => {
  if (!(error instanceof Error)) {
    return { type: typeof error };
  }

  const result: SafeErrorLog = { type: error.name };

  if ("code" in error && typeof error.code === "string" && SAFE_CODE.test(error.code)) {
    result.code = error.code;
  }

  const sqlState = postgresErrorCode(error);
  if (sqlState !== undefined && sqlState !== result.code) {
    result.sqlState = sqlState;
  }

  const transactionFailure = classifyTransactionFailure(error);
  if (transactionFailure !== undefined) {
    result.transactionFailure = transactionFailure;
  }

  const frames = error.stack
    ?.split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(0, 15)
    .join("\n");

  if (frames) {
    result.stack = frames;
  }

  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    result.cause = describe(error.cause, depth + 1);
  }

  return result;
};

export const describeError = (error: unknown): SafeErrorLog => describe(error, 0);
