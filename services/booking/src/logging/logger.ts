import { pino } from "pino";
import type { DestinationStream, Logger, LevelWithSilent } from "pino";

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

  return destination === undefined ? pino(pinoOptions) : pino(pinoOptions, destination);
};

export type SafeErrorLog = {
  type: string;
  code?: string;
  stack?: string;
};

// Node/driver codes (EADDRINUSE, P2002) and PostgreSQL SQLSTATE (42501).
const SAFE_CODE = /^(?:[A-Z][A-Z0-9_]{0,39}|[0-9A-Z]{5})$/;

/**
 * Describes an error for logs without its message: provider and driver errors
 * (Brevo, Prisma, pg) may embed connection strings, emails or keys in messages.
 * Keeps the class name, a short machine code (e.g. EADDRINUSE, P2002, SQLSTATE) and
 * stack frames without the first (message) line.
 */
export const describeError = (error: unknown): SafeErrorLog => {
  if (!(error instanceof Error)) {
    return { type: typeof error };
  }

  const result: SafeErrorLog = { type: error.name };

  if ("code" in error && typeof error.code === "string" && SAFE_CODE.test(error.code)) {
    result.code = error.code;
  }

  const frames = error.stack
    ?.split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(0, 15)
    .join("\n");

  if (frames) {
    result.stack = frames;
  }

  return result;
};
