import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CALENDAR_LOCK_KEY, createCalendarTransaction } from "../../src/modules/schedule/calendar-transaction.js";
import { localDateTimeToInstant } from "../../src/modules/schedule/zoned-time.js";
import { createDatabase, type Database } from "../../src/shared/database/database.js";
import { classifyTransactionFailure } from "../../src/shared/database/transaction-failure.js";
import { AppError } from "../../src/shared/errors/app-error.js";
import { createCapturingLogger } from "../helpers/logs.js";
import { bearer, countRows, createUsers, insertService, resetCalendar, startBookingStack, type BookingStack } from "./helpers/booking-app.js";

// Real failures of interactive transactions on PostgreSQL (not mocked): a lock
// held by another session, no free connection, an expired transaction, a
// misused one. Only waits for a lock or a connection answer "busy"; every
// other failure keeps its original error for the standard handler.

let stack: BookingStack;
let users: Awaited<ReturnType<typeof createUsers>>;
const databases: Database[] = [];

const SHORT_MS = 300;

const database = (poolMax: number): Database => {
  const created = createDatabase(
    { url: stack.db.url("app"), sslMode: "disable", poolMax, connectTimeoutMs: 5_000, queryTimeoutMs: 10_000 },
    createCapturingLogger().logger,
  );
  databases.push(created);
  return created;
};

const errorBody = (response: request.Response): unknown => {
  const body: unknown = response.body;
  return body;
};

/** Rejection of `promise`, or a failure when it resolves. */
const failureOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
};

const causeOf = (error: unknown): unknown => (error instanceof Error ? error.cause : undefined);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rows written by the probes below (Sunday 10:00–11:00; the app role may write the schedule). */
const probeRows = () => countRows(stack.db, `SELECT count(*)::int AS n FROM "WeeklyScheduleInterval" WHERE weekday = 7`);

beforeAll(async () => {
  stack = await startBookingStack(1);
  users = await createUsers(stack);
});

afterAll(async () => {
  await Promise.all(databases.map((created) => created.close()));
  await stack.close();
});

beforeEach(async () => {
  await resetCalendar(stack.db);
});

describe("the calendar transaction on a real database", () => {
  it("success: runs the work under the lock and commits it", async () => {
    const calendar = createCalendarTransaction(database(2).prisma, { lockTimeoutMs: SHORT_MS });
    const result = await calendar(async (tx) => {
      await tx.$executeRaw`INSERT INTO "WeeklyScheduleInterval" (id, weekday, "startMinute", "endMinute") VALUES (gen_random_uuid(), 7, 600, 660)`;
      return "done";
    });
    expect(result).toBe("done");
    expect(await probeRows()).toBe(1);
  });

  it("the advisory lock held by another session: CALENDAR_BUSY, the 55P03 kept as the cause", async () => {
    const calendar = createCalendarTransaction(database(2).prisma, { lockTimeoutMs: SHORT_MS });
    const holder = await stack.db.connect("admin");
    try {
      await holder.query(`SELECT pg_advisory_lock(${String(CALENDAR_LOCK_KEY)})`);
      const error = await failureOf(calendar(() => Promise.resolve("never")));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ statusCode: 503, code: "CALENDAR_BUSY", details: { retryAfterSeconds: 2 } });
      expect(classifyTransactionFailure(causeOf(error))).toBe("lock_not_available");
    } finally {
      await holder.end();
    }
  });

  it("no free connection within maxWait: CALENDAR_BUSY (nothing ran), the P2028 start timeout kept as the cause", async () => {
    const single = database(1);
    const calendar = createCalendarTransaction(single.prisma, { lockTimeoutMs: SHORT_MS });
    const occupying = single.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_sleep(1)`;
    });
    await sleep(100);
    const error = await failureOf(calendar(() => Promise.resolve("never")));
    await occupying;
    expect(error).toMatchObject({ statusCode: 503, code: "CALENDAR_BUSY" });
    expect(classifyTransactionFailure(causeOf(error))).toBe("transaction_start_timeout");
  });

  it("the work outlives the transaction timeout: the original P2028 (not busy), nothing committed", async () => {
    const calendar = createCalendarTransaction(database(2).prisma, { lockTimeoutMs: SHORT_MS });
    const error = await failureOf(
      calendar(async (tx) => {
        await tx.$executeRaw`INSERT INTO "WeeklyScheduleInterval" (id, weekday, "startMinute", "endMinute") VALUES (gen_random_uuid(), 7, 600, 660)`;
        await sleep(3 * SHORT_MS + 300);
        await tx.$queryRaw`SELECT 1 AS alive`;
      }),
    );
    expect(error).not.toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "P2028" });
    expect(classifyTransactionFailure(error)).toBe("transaction_expired");
    expect(await probeRows()).toBe(0);
  });

  it("a transaction client used after its commit: the original P2028 (not busy)", async () => {
    const calendar = createCalendarTransaction(database(2).prisma, { lockTimeoutMs: SHORT_MS });
    const leaked: { tx?: Parameters<Parameters<typeof calendar>[0]>[0] } = {};
    await calendar((tx) => {
      leaked.tx = tx;
      return Promise.resolve();
    });
    const error = await failureOf(
      calendar(async () => {
        const { tx } = leaked;
        if (tx === undefined) {
          throw new Error("the first transaction did not run");
        }
        await tx.$queryRaw`SELECT 1 AS alive`;
      }),
    );
    expect(error).not.toBeInstanceOf(AppError);
    expect(classifyTransactionFailure(error)).toBe("transaction_closed");
  });

  it("other database errors of the work pass through unchanged", async () => {
    const calendar = createCalendarTransaction(database(2).prisma, { lockTimeoutMs: SHORT_MS });
    const error = await failureOf(
      calendar(async (tx) => {
        await tx.$executeRaw`SELECT 1 / 0`;
      }),
    );
    expect(error).not.toBeInstanceOf(AppError);
    expect(classifyTransactionFailure(error)).toBeUndefined();
  });
});

describe("HTTP under a real lock (production waits of 5 s)", () => {
  const paris = (date: string, hhmm: string): string => {
    const [h = "0", m = "0"] = hhmm.split(":");
    return localDateTimeToInstant(date, Number(h) * 60 + Number(m), "Europe/Paris").toISOString();
  };

  it("booking while another session holds the calendar lock: 503 CALENDAR_BUSY + Retry-After, no database details; the same key then books", async () => {
    stack.setNow("2027-03-01T06:00:00Z");
    const serviceId = await insertService(stack.db, { name: "Massage 60", durationMinutes: 60, priceCents: 6500 });
    await request(stack.app)
      .put("/api/admin/schedule/weekly")
      .set(bearer(users.admin))
      .send({ intervals: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "21:00" })) })
      .expect(200);
    const book = () =>
      request(stack.app)
        .post("/api/bookings")
        .set(bearer(users.clientA))
        .set("Idempotency-Key", "busy-key-0001")
        .send({ serviceId, startsAt: paris("2027-03-02", "10:00") });

    const holder = await stack.db.connect("admin");
    try {
      await holder.query(`SELECT pg_advisory_lock(${String(CALENDAR_LOCK_KEY)})`);
      const busy = await book();
      expect(busy.status).toBe(503);
      expect(busy.get("Retry-After")).toBe("2");
      expect(errorBody(busy)).toEqual({ message: "The calendar is busy; retry shortly", code: "CALENDAR_BUSY", retryAfterSeconds: 2 });
      expect(busy.text).not.toMatch(/55P03|P20\d\d|lock timeout|Prisma|advisory/i);
    } finally {
      await holder.end();
    }
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "Booking"`)).toBe(0);
    expect((await book()).status).toBe(201);
  });

  it("a gift card request while another session holds the client's row: 503 GIFT_CARD_REQUEST_BUSY + Retry-After; the same key then succeeds", async () => {
    stack.setNow("2027-03-01T07:00:00Z");
    const submit = () =>
      request(stack.app)
        .post("/api/gift-card-requests")
        .set(bearer(users.clientA))
        .set("Idempotency-Key", "gift-busy-0001")
        .send({ amountCents: 5000, preferredContactChannel: "email" });

    const holder = await stack.db.connect("admin");
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM "UserProfile" FOR UPDATE`);
      const busy = await submit();
      expect(busy.status).toBe(503);
      expect(busy.get("Retry-After")).toBe("2");
      expect(errorBody(busy)).toEqual({ message: "Gift card requests are busy; retry shortly", code: "GIFT_CARD_REQUEST_BUSY", retryAfterSeconds: 2 });
      expect(busy.text).not.toMatch(/55P03|P20\d\d|lock timeout|Prisma|UserProfile/i);
      await holder.query("ROLLBACK");
    } finally {
      await holder.end();
    }
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "GiftCardRequest"`)).toBe(0);
    const created = await submit();
    expect(created.status).toBe(201);
    expect(z.object({ giftCardRequest: z.object({ status: z.literal("new") }) }).safeParse(created.body).success).toBe(true);
  });
});
