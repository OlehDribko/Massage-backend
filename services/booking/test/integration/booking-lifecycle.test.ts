import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CALENDAR_LOCK_KEY, LOCK_TIMEOUT_MS } from "../../src/modules/schedule/calendar-transaction.js";
import { localDateTimeToInstant } from "../../src/modules/schedule/zoned-time.js";
import {
  bearer,
  bookingIdOf,
  countRows,
  createUsers,
  insertService,
  resetCalendar,
  startBookingStack,
  type BookingStack,
} from "./helpers/booking-app.js";

// The booking lifecycle through the API, checked against the rows in
// PostgreSQL (not only the HTTP answers): create → read → move → cancel,
// races between two clients, retries, refused requests, and a failing outbox.
// Identities are the fake provider, and the clock is controlled. The real
// Firebase adapter with Auth Emulator tokens on POST /api/bookings (ready,
// incomplete, expired, revoked) is in auth-profiles.test.ts; real Google
// signatures need a live Firebase project (docs/firebase-staging-checklist.md).

let stack: BookingStack;
let users: Awaited<ReturnType<typeof createUsers>>;
let serviceId: string;

const paris = (date: string, hhmm: string): string => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return localDateTimeToInstant(date, Number(h) * 60 + Number(m), "Europe/Paris").toISOString();
};

const DAY = "2027-03-02";

let keyCounter = 0;
const nextKey = () => `life-${String((keyCounter += 1)).padStart(8, "0")}`;
const book = (token: string, startsAt: string, key = nextKey(), app = stack.app) =>
  request(app).post("/api/bookings").set(bearer(token)).set("Idempotency-Key", key).send({ serviceId, startsAt });
const reschedule = (token: string, id: string, startsAt: string) =>
  request(stack.app).post(`/api/bookings/${id}/reschedule`).set(bearer(token)).send({ startsAt });
const cancel = (token: string, id: string) => request(stack.app).post(`/api/bookings/${id}/cancel`).set(bearer(token)).send({});
const read = (token: string, id: string) => request(stack.app).get(`/api/bookings/${id}`).set(bearer(token));

const bodyOf = (response: request.Response): unknown => {
  const body: unknown = response.body;
  return body;
};

const slots = async (): Promise<string[]> => {
  const response = await request(stack.app).get(`/api/services/${serviceId}/availability?from=${DAY}&to=${DAY}`).expect(200);
  const parsed = z
    .object({ days: z.array(z.object({ date: z.string(), slots: z.array(z.object({ startsAt: z.string() })) })) })
    .parse(bodyOf(response));
  return parsed.days.find((day) => day.date === DAY)?.slots.map((slot) => slot.startsAt) ?? [];
};

const bookingRowSchema = z.object({
  id: z.string(),
  clientProfileId: z.string(),
  status: z.string(),
  startsAt: z.date(),
  endsAt: z.date(),
  blockedUntil: z.date(),
  cancelledBy: z.string().nullable(),
});
const bookingRows = async () => {
  const result = await stack.db.query(
    "admin",
    `SELECT id::text, "clientProfileId"::text, status::text, "startsAt", "endsAt", "blockedUntil", "cancelledBy"::text AS "cancelledBy"
       FROM "Booking" ORDER BY "createdAt", id`,
  );
  const rows: unknown = result.rows;
  return z.array(bookingRowSchema).parse(rows);
};
const bookingRow = async (id: string) => {
  const row = (await bookingRows()).find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(`booking ${id} not in the database`);
  }
  return row;
};

const eventTypesOf = async (bookingId?: string): Promise<string[]> => {
  const result = await stack.db.query(
    "admin",
    `SELECT type FROM "OutboxEvent" ${bookingId === undefined ? "" : `WHERE "aggregateId" = '${bookingId}'`} ORDER BY position`,
  );
  const rows: unknown = result.rows;
  return z.array(z.object({ type: z.string() })).parse(rows).map((row) => row.type);
};

const counts = async () => ({
  bookings: await countRows(stack.db, `SELECT count(*)::int AS n FROM "Booking"`),
  timeChanges: await countRows(stack.db, `SELECT count(*)::int AS n FROM "BookingTimeChange"`),
  events: await countRows(stack.db, `SELECT count(*)::int AS n FROM "OutboxEvent"`),
});

const profileIdOf = async (token: string): Promise<string> => {
  const response = await request(stack.app).get("/api/me").set(bearer(token)).expect(200);
  return z.object({ profile: z.object({ id: z.string() }) }).parse(bodyOf(response)).profile.id;
};

type LockControl = {
  /** Sessions waiting for the calendar lock right now. */
  waiting: () => Promise<number>;
  release: () => Promise<void>;
};

/** Runs `work` while another session holds the calendar lock (until `release`, or the end of `work`). */
const withCalendarLockHeld = async <T>(work: (lock: LockControl) => Promise<T>): Promise<T> => {
  const holder = await stack.db.connect("admin");
  try {
    await holder.query(`SELECT pg_advisory_lock(${String(CALENDAR_LOCK_KEY)})`);
    return await work({
      waiting: async () => {
        const result = await holder.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
        const row: unknown = result.rows[0];
        return z.object({ n: z.number() }).parse(row).n;
      },
      release: async () => {
        await holder.query(`SELECT pg_advisory_unlock(${String(CALENDAR_LOCK_KEY)})`);
      },
    });
  } finally {
    await holder.end();
  }
};

/** Status and error code of an answer, for failure messages (fixture data only). */
const outcomeOf = (result: PromiseSettledResult<request.Response>): string => {
  if (result.status === "rejected") {
    return `no answer (${result.reason instanceof Error ? result.reason.name : "unknown"})`;
  }
  const code = z.object({ code: z.string() }).safeParse(bodyOf(result.value));
  return `${String(result.value.status)} ${code.success ? code.data.code : "-"}`;
};

// Margin before the first waiter's lock_timeout, so that every waiter is
// still waiting when the lock is released.
const LOCK_RELEASE_MARGIN_MS = 1_500;
// Before anyone waits no lock_timeout runs; this only bounds a stuck setup.
const MAX_SETUP_MS = 60_000;

/**
 * Waits until `count` sessions wait for the calendar lock. The clock that
 * matters starts when the first one waits (its lock_timeout runs from then);
 * a slow start (cold pools, a slow database) costs nothing. Throws with what
 * was seen when the others cannot arrive in time.
 */
const untilWaiting = async (lock: LockControl, count: number): Promise<void> => {
  const startedAt = Date.now();
  let firstWaitAt: number | undefined;
  for (;;) {
    const waiting = await lock.waiting();
    if (waiting >= count) {
      return;
    }
    const now = Date.now();
    if (waiting > 0) {
      firstWaitAt ??= now;
    }
    const firstWaitedMs = firstWaitAt === undefined ? null : now - firstWaitAt;
    if ((firstWaitedMs !== null && firstWaitedMs > LOCK_TIMEOUT_MS - LOCK_RELEASE_MARGIN_MS) || now - startedAt > MAX_SETUP_MS) {
      throw new Error(
        `synchronisation: ${String(waiting)} of ${String(count)} requests wait for the calendar lock after ${String(now - startedAt)} ms` +
          ` (the first has waited ${firstWaitedMs === null ? "-" : `${String(firstWaitedMs)} ms`})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

beforeAll(async () => {
  stack = await startBookingStack(2);
  users = await createUsers(stack);
  stack.identities.fail("token-expired", "expired");
  stack.identities.fail("token-revoked", "revoked");
  stack.identities.fail("token-disabled", "disabled");
});

afterAll(async () => {
  await stack.close();
});

// Nothing a test started may outlive it: a request still running (or waiting
// for the calendar lock) would collide with the next test's cleanup.
afterEach(async () => {
  const result = await stack.db.query(
    "admin",
    `SELECT state, wait_event_type AS "waitEventType" FROM pg_stat_activity WHERE usename = 'booking_app' AND state <> 'idle'`,
  );
  const rows: unknown = result.rows;
  const busy = z.array(z.object({ state: z.string().nullable(), waitEventType: z.string().nullable() })).parse(rows);
  expect(busy, "sessions of the app still busy after the test").toEqual([]);
  expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`)).toBe(0);
});

beforeEach(async () => {
  await resetCalendar(stack.db);
  stack.setNow("2027-03-01T06:00:00Z"); // Monday 07:00 in Paris: the next day is bookable
  serviceId = await insertService(stack.db, { name: "Massage 60", durationMinutes: 60, priceCents: 6500 });
  await request(stack.app)
    .put("/api/admin/schedule/weekly")
    .set(bearer(users.admin))
    .send({ intervals: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "21:00" })) })
    .expect(200);
});

describe("lifecycle: book, read, move, cancel", () => {
  it("every step is visible in the next request and in the database; freed times can be booked again", async () => {
    const nine = paris(DAY, "09:00");
    const eleven = paris(DAY, "11:00");
    const clientA = await profileIdOf(users.clientA);
    expect(await slots()).toContain(nine);

    // Book.
    const created = await book(users.clientA, nine).expect(201);
    const id = bookingIdOf(created);
    expect(await bookingRow(id)).toMatchObject({
      clientProfileId: clientA,
      status: "confirmed",
      startsAt: new Date(nine),
      endsAt: new Date(Date.parse(nine) + 60 * 60_000),
      blockedUntil: new Date(Date.parse(nine) + 75 * 60_000),
      cancelledBy: null,
    });
    expect(await slots()).not.toContain(nine);
    expect(bodyOf(await read(users.clientA, id).expect(200))).toMatchObject({ booking: { id, status: "confirmed", startsAt: nine } });
    expect(bodyOf(await book(users.clientB, nine))).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "taken" });

    // Move: the old time is free at once, for anyone.
    expect(bodyOf(await reschedule(users.clientA, id, eleven).expect(200))).toMatchObject({ changed: true, booking: { startsAt: eleven } });
    expect(await bookingRow(id)).toMatchObject({ status: "confirmed", startsAt: new Date(eleven), blockedUntil: new Date(Date.parse(eleven) + 75 * 60_000) });
    expect(bodyOf(await read(users.clientA, id).expect(200))).toMatchObject({ booking: { startsAt: eleven } });
    expect(await slots()).toContain(nine);
    expect(await slots()).not.toContain(eleven);
    const clientBBooking = bookingIdOf(await book(users.clientB, nine).expect(201));

    // Cancel: stays in the history, frees its time.
    expect(bodyOf(await cancel(users.clientA, id).expect(200))).toMatchObject({ changed: true, booking: { status: "cancelled" } });
    expect(await bookingRow(id)).toMatchObject({ status: "cancelled", startsAt: new Date(eleven), cancelledBy: "client" });
    expect(bodyOf(await read(users.clientA, id).expect(200))).toMatchObject({ booking: { status: "cancelled", phase: "cancelled" } });
    expect(await slots()).toContain(eleven);
    await book(users.clientB, eleven).expect(201);

    expect(await eventTypesOf(id)).toEqual(["booking.created", "booking.rescheduled", "booking.cancelled"]);
    expect(await eventTypesOf(clientBBooking)).toEqual(["booking.created"]);
    expect(await counts()).toEqual({ bookings: 3, timeChanges: 1, events: 5 });
  });
});

describe("two clients, one time", () => {
  it("both requests wait on the calendar lock, then run one after another: one booking, the other 409 SLOT_UNAVAILABLE", async () => {
    const nine = paris(DAY, "09:00");
    const settled = await withCalendarLockHeld(async (lock) => {
      // Two instances (separate pools), different clients and keys; both are
      // inside their transaction and blocked on the lock before it is released.
      const racing = Promise.allSettled([book(users.clientA, nine, nextKey(), stack.apps[0]), book(users.clientB, nine, nextKey(), stack.apps[1])]);
      let notSynchronised: unknown;
      try {
        await untilWaiting(lock, 2);
      } catch (error) {
        notSynchronised = error;
      }
      // Whatever happened, both requests end inside this test: none is left
      // running into the next one (its TRUNCATE would deadlock with it).
      await lock.release();
      const results = await racing;
      if (notSynchronised !== undefined) {
        const message = notSynchronised instanceof Error ? notSynchronised.message : "synchronisation failed";
        throw new Error(`${message}; answers after release: ${results.map(outcomeOf).join(", ")}`);
      }
      return results;
    });
    const outcomes = settled.map(outcomeOf);
    expect(outcomes.slice().sort()).toEqual(["201 -", "409 SLOT_UNAVAILABLE"]);
    const [first, second] = settled.map((result) => (result.status === "fulfilled" ? result.value : undefined));
    const responses = [first, second];
    const loser = responses.find((response) => response?.status === 409);
    if (loser === undefined) {
      throw new Error("no 409 among the responses");
    }
    expect(bodyOf(loser)).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "taken" });

    const rows = await bookingRows();
    expect(rows).toHaveLength(1);
    const winnerToken = first?.status === 201 ? users.clientA : users.clientB;
    expect(rows[0]?.clientProfileId).toBe(await profileIdOf(winnerToken));
    expect(await eventTypesOf()).toEqual(["booking.created"]);
  });

  it("a time taken is 409 SLOT_UNAVAILABLE; a calendar held too long is 503 CALENDAR_BUSY with Retry-After, and nothing is stored", async () => {
    const nine = paris(DAY, "09:00");
    const key = nextKey();
    const busy = await withCalendarLockHeld(() => book(users.clientA, nine, key));
    expect(outcomeOf({ status: "fulfilled", value: busy })).toBe("503 CALENDAR_BUSY");
    expect(busy.headers["retry-after"]).toBe("2");
    expect(bodyOf(busy)).toEqual({ message: "The calendar is busy; retry shortly", code: "CALENDAR_BUSY", retryAfterSeconds: 2 });
    expect(await counts()).toEqual({ bookings: 0, timeChanges: 0, events: 0 });

    // The same request again (same key) once the calendar is free: booked.
    await book(users.clientA, nine, key).expect(201);
    const taken = await book(users.clientB, nine);
    expect(taken.status).toBe(409);
    expect(taken.headers["retry-after"]).toBeUndefined();
    expect(bodyOf(taken)).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "taken" });
    expect(await counts()).toEqual({ bookings: 1, timeChanges: 0, events: 1 });
  });
});

describe("repeating a request", () => {
  it("the same key and payload replay the booking (200, Idempotent-Replayed); the same key with another payload is 422 and changes nothing", async () => {
    const nine = paris(DAY, "09:00");
    const key = nextKey();
    const id = bookingIdOf(await book(users.clientA, nine, key).expect(201));

    const replay = await book(users.clientA, nine, key, stack.apps[1]);
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(bookingIdOf(replay)).toBe(id);

    const reusedTime = await book(users.clientA, paris(DAY, "11:00"), key);
    expect(reusedTime.status).toBe(422);
    expect(bodyOf(reusedTime)).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    const otherService = await insertService(stack.db, { name: "Massage 90", durationMinutes: 90, priceCents: 9000 });
    const reusedService = await request(stack.app)
      .post("/api/bookings")
      .set(bearer(users.clientA))
      .set("Idempotency-Key", key)
      .send({ serviceId: otherService, startsAt: nine });
    expect(reusedService.status).toBe(422);
    expect(bodyOf(reusedService)).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    expect(await counts()).toEqual({ bookings: 1, timeChanges: 0, events: 1 });
    expect(await bookingRow(id)).toMatchObject({ status: "confirmed", startsAt: new Date(nine) });
    expect(await slots()).toContain(paris(DAY, "11:00"));
  });
});

describe("refused requests store nothing", () => {
  it("no token, an expired, revoked or disabled session, a guest, an unverified or incomplete profile: no booking, no event", async () => {
    const nine = paris(DAY, "09:00");
    const noToken = await request(stack.app).post("/api/bookings").set("Idempotency-Key", nextKey()).send({ serviceId, startsAt: nine });
    expect([noToken.status, bodyOf(noToken)]).toEqual([401, expect.objectContaining({ code: "AUTH_REQUIRED" })]);

    const cases: [string, number, Record<string, unknown>][] = [
      ["token-expired", 401, { code: "TOKEN_EXPIRED" }],
      ["token-revoked", 401, { code: "SESSION_REVOKED" }],
      ["token-disabled", 403, { code: "ACCOUNT_DISABLED" }],
      ["token-unknown", 401, { code: "INVALID_TOKEN" }],
      [users.guest, 403, { code: "BOOKING_NOT_READY", blockers: ["anonymous_session", "email_not_verified", "name_missing", "phone_missing"] }],
      [users.unverified, 403, { code: "BOOKING_NOT_READY", blockers: ["email_not_verified"] }],
      [users.incomplete, 403, { code: "BOOKING_NOT_READY", blockers: ["name_missing", "phone_missing"] }],
    ];
    for (const [token, status, body] of cases) {
      const response = await book(token, nine);
      expect([token, response.status, bodyOf(response)]).toEqual([token, status, expect.objectContaining(body)]);
    }
    expect(await counts()).toEqual({ bookings: 0, timeChanges: 0, events: 0 });
    expect(await slots()).toContain(nine);
  });

  it("someone else's booking: 404 for read, move and cancel; an expired session cannot change one's own; the booking and its events stay as they were", async () => {
    const nine = paris(DAY, "09:00");
    const id = bookingIdOf(await book(users.clientA, nine).expect(201));

    expect((await read(users.clientB, id)).status).toBe(404);
    expect(bodyOf(await reschedule(users.clientB, id, paris(DAY, "11:00")))).toMatchObject({ code: "BOOKING_NOT_FOUND" });
    expect((await cancel(users.clientB, id)).status).toBe(404);
    expect(bodyOf(await reschedule("token-expired", id, paris(DAY, "11:00")))).toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(bodyOf(await cancel("token-revoked", id))).toMatchObject({ code: "SESSION_REVOKED" });

    expect(await bookingRow(id)).toMatchObject({ status: "confirmed", startsAt: new Date(nine), cancelledBy: null });
    expect(await counts()).toEqual({ bookings: 1, timeChanges: 0, events: 1 });
  });
});

describe("a failing outbox write rolls the change back", () => {
  it("move and cancel: 500, the booking keeps its time and status, no history row, no event", async () => {
    const nine = paris(DAY, "09:00");
    const id = bookingIdOf(await book(users.clientA, nine).expect(201));

    await stack.db.query("admin", `ALTER TABLE "OutboxEvent" ADD CONSTRAINT "test_reject_all" CHECK (false) NOT VALID`);
    try {
      const moved = await reschedule(users.clientA, id, paris(DAY, "11:00"));
      expect([moved.status, bodyOf(moved)]).toEqual([500, { message: "internal server error" }]);
      const cancelled = await cancel(users.clientA, id);
      expect(cancelled.status).toBe(500);
    } finally {
      await stack.db.query("admin", `ALTER TABLE "OutboxEvent" DROP CONSTRAINT "test_reject_all"`);
    }

    expect(await bookingRow(id)).toMatchObject({ status: "confirmed", startsAt: new Date(nine), cancelledBy: null });
    expect(await counts()).toEqual({ bookings: 1, timeChanges: 0, events: 1 });
    expect(await slots()).toContain(paris(DAY, "11:00"));
    expect(await slots()).not.toContain(nine);

    // Once the outbox works again, the same requests succeed.
    await reschedule(users.clientA, id, paris(DAY, "11:00")).expect(200);
    await cancel(users.clientA, id).expect(200);
    expect(await eventTypesOf(id)).toEqual(["booking.created", "booking.rescheduled", "booking.cancelled"]);
  });
});
