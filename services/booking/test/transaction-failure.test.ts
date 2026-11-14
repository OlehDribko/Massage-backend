import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { describeDatabaseFailure } from "../src/admin/database-failure.js";
import { createApp } from "../src/app.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { REQUEST_ID_HEADER } from "../src/http/request-logging.js";
import { describeError } from "../src/logging/logger.js";
import {
  classifyTransactionFailure,
  isRetryableTransactionFailure,
  type TransactionFailure,
} from "../src/shared/database/transaction-failure.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { createCapturingLogger } from "./helpers/logs.js";

// Errors built in the shapes Prisma 7.10 + @prisma/adapter-pg produce against
// PostgreSQL 17 (the integration test transaction-failures.test.ts gets the
// real ones from a database). Messages carry a sentinel: it must never reach
// a response or a log.

const SENTINEL = "SENTINEL_DB_DETAIL";

const known = (message: string, code: string, meta: Record<string, unknown> = {}) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "7.10.1", meta });

const driverError = (sqlState: string) =>
  Object.assign(new Error(`${SENTINEL} canceling statement`), {
    name: "DriverAdapterError",
    cause: { originalCode: sqlState, originalMessage: SENTINEL, kind: "postgres", code: sqlState },
  });

const errors = {
  rawLockTimeout: known(`\nInvalid \`prisma.$queryRaw()\` invocation:\n\n\nRaw query failed. Code: \`55P03\`. ${SENTINEL}`, "P2010", {
    driverAdapterError: driverError("55P03"),
  }),
  modelLockTimeout: known(`\nInvalid \`tx.giftCardRequest.update()\` invocation\nDatabase error. Code: \`55P03\`. ${SENTINEL}`, "P2039", {
    modelName: "GiftCardRequest",
    driverAdapterError: driverError("55P03"),
  }),
  startTimeout: known("Transaction API error: Unable to start a transaction in the given time.", "P2028"),
  expiredQuery: known(
    "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nTransaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms, however 15003 ms passed since the start of the transaction.",
    "P2028",
    { operation: "query", timeout: 15_000, timeTaken: 15_003 },
  ),
  expiredCommit: known(
    "Transaction API error: A commit cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms, however 15866 ms passed since the start of the transaction.",
    "P2028",
    { operation: "commit", timeout: 15_000, timeTaken: 15_866 },
  ),
  closed: known("Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.", "P2028"),
  notFound: known("Transaction API error: Transaction not found. Transaction ID is invalid.", "P2028"),
  statementTimeout: known(`Raw query failed. Code: \`57014\`. ${SENTINEL}`, "P2010", { driverAdapterError: driverError("57014") }),
  uniqueViolation: known(`Unique constraint failed ${SENTINEL}`, "P2002", { modelName: "Booking" }),
};

type ErrorName = keyof typeof errors;

const CASES: { name: ErrorName; failure: TransactionFailure | undefined; retryable: boolean }[] = [
  { name: "rawLockTimeout", failure: "lock_not_available", retryable: true },
  { name: "modelLockTimeout", failure: "lock_not_available", retryable: true },
  { name: "startTimeout", failure: "transaction_start_timeout", retryable: true },
  { name: "expiredQuery", failure: "transaction_expired", retryable: false },
  { name: "expiredCommit", failure: "transaction_expired", retryable: false },
  { name: "closed", failure: "transaction_closed", retryable: false },
  { name: "notFound", failure: "transaction_api_error", retryable: false },
  { name: "statementTimeout", failure: undefined, retryable: false },
  { name: "uniqueViolation", failure: undefined, retryable: false },
];

describe("classifyTransactionFailure", () => {
  it("tells a lock wait from a start timeout, an expired transaction and other P2028", () => {
    for (const { name, failure, retryable } of CASES) {
      const found = classifyTransactionFailure(errors[name]);
      expect({ name, found, retryable: isRetryableTransactionFailure(found) }).toEqual({ name, found: failure, retryable });
    }
  });

  it("finds 55P03 in a driver error nested under cause; ignores values that are not errors", () => {
    expect(classifyTransactionFailure(new Error("wrapper", { cause: errors.rawLockTimeout }))).toBe("lock_not_available");
    expect(classifyTransactionFailure(driverError("55P03"))).toBe("lock_not_available");
    expect(classifyTransactionFailure(undefined)).toBeUndefined();
    expect(classifyTransactionFailure("P2028")).toBeUndefined();
    expect(isRetryableTransactionFailure(undefined)).toBe(false);
  });

  it("gives the owner's diagnostics the real P2028 variants (messages carry a prefix)", () => {
    expect(describeDatabaseFailure(errors.startTimeout)).toMatchObject({ cause: "transaction_start_timeout", prismaCode: "P2028" });
    expect(describeDatabaseFailure(errors.expiredCommit)).toMatchObject({ cause: "transaction_timeout", prismaCode: "P2028" });
    expect(describeDatabaseFailure(errors.closed)).toMatchObject({ cause: "transaction_api_error" });
  });
});

describe("describeError with a cause", () => {
  it("keeps the original failure, its SQLSTATE and kind, without any message", () => {
    const busy = new AppError(503, "The calendar is busy; retry shortly", { code: "CALENDAR_BUSY", cause: errors.rawLockTimeout });

    const described = describeError(busy);

    expect(described).toMatchObject({
      type: "Error",
      cause: { type: "PrismaClientKnownRequestError", code: "P2010", sqlState: "55P03", transactionFailure: "lock_not_available" },
    });
    expect(JSON.stringify(described)).not.toContain(SENTINEL);
    expect(JSON.stringify(describeError(errors.expiredCommit))).not.toContain("15866");
  });

  it("stops after a few levels of causes", () => {
    let error = new Error("root");
    for (let i = 0; i < 10; i += 1) {
      error = new Error(`level ${String(i)}`, { cause: error });
    }
    let depth = 0;
    for (let level = describeError(error).cause; level !== undefined; level = level.cause) {
      depth += 1;
    }
    expect(depth).toBe(3);
  });
});

describe("HTTP answers to transaction failures", () => {
  const buildApp = (thrown: unknown) => {
    const logs = createCapturingLogger();
    const router = Router();
    router.post("/work", () => {
      throw thrown;
    });
    const app = createApp({
      logger: logs.logger,
      isShuttingDown: () => false,
      probeReadiness: () => Promise.resolve("ready"),
      appVersion: undefined,
      cors: undefined,
      apiRouter: router,
    });
    return { app, logs };
  };

  it("busy: the module's 503 contract with Retry-After; the cause only in the log, under the request id", async () => {
    const thrown = new AppError(503, "The calendar is busy; retry shortly", {
      code: "CALENDAR_BUSY",
      details: { retryAfterSeconds: 2 },
      cause: errors.rawLockTimeout,
    });
    const { app, logs } = buildApp(thrown);

    const response = await request(app).post("/api/work").send({});

    expect(response.status).toBe(503);
    expect(response.get("Retry-After")).toBe("2");
    const body: unknown = response.body;
    expect(body).toEqual({ message: "The calendar is busy; retry shortly", code: "CALENDAR_BUSY", retryAfterSeconds: 2 });
    expect(response.text).not.toMatch(/55P03|P2010|SENTINEL|Prisma|lock timeout/);

    const entry = logs.entries().find((logged) => logged.msg === "request failed with server error");
    expect(entry).toMatchObject({
      requestId: response.get(REQUEST_ID_HEADER),
      error: { cause: { code: "P2010", sqlState: "55P03", transactionFailure: "lock_not_available" } },
    });
    expect(logs.raw()).not.toContain(SENTINEL);
  });

  it("an expired transaction: the neutral 500, logged with its kind", async () => {
    const { app, logs } = buildApp(errors.expiredCommit);

    const response = await request(app).post("/api/work").send({});

    expect(response.status).toBe(500);
    expect(response.get("Retry-After")).toBeUndefined();
    const body: unknown = response.body;
    expect(body).toEqual({ message: "internal server error" });

    const entry = logs.entries().find((logged) => logged.msg === "unhandled error");
    expect(entry).toMatchObject({
      requestId: response.get(REQUEST_ID_HEADER),
      error: { type: "PrismaClientKnownRequestError", code: "P2028", transactionFailure: "transaction_expired" },
    });
  });
});
