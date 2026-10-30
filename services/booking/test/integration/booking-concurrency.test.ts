import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { localDateTimeToInstant } from "../../src/modules/schedule/zoned-time.js";
import {
  bearer,
  bookingIdOf,
  countRows,
  createUsers,
  resetCalendar,
  serviceIdOf,
  startBookingStack,
  type BookingStack,
} from "./helpers/booking-app.js";

// Concurrency across two API instances with separate connection pools (like
// two processes): the calendar lock is a PostgreSQL advisory lock, and the
// exclusion constraint guards the table itself.

let stack: BookingStack;
let users: Awaited<ReturnType<typeof createUsers>>;
let serviceId: string;

const paris = (date: string, hhmm: string): string => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return localDateTimeToInstant(date, Number(h) * 60 + Number(m), "Europe/Paris").toISOString();
};

const instance = (i: number) => {
  const app = stack.apps[i % stack.apps.length];
  if (app === undefined) {
    throw new Error("no app");
  }
  return app;
};

let keyCounter = 0;
const nextKey = () => `conc-${String((keyCounter += 1)).padStart(8, "0")}`;
const book = (i: number, token: string, startsAt: string, key = nextKey()) =>
  request(instance(i)).post("/api/bookings").set(bearer(token)).set("Idempotency-Key", key).send({ serviceId, startsAt });

const statuses = (responses: request.Response[]): number[] => responses.map((response) => response.status).sort();

const eventTypes = async (): Promise<string[]> => {
  const result = await stack.db.query("admin", `SELECT type FROM "OutboxEvent" ORDER BY position`);
  const rows: unknown = result.rows;
  return z.array(z.object({ type: z.string() })).parse(rows).map((row) => row.type);
};

beforeAll(async () => {
  stack = await startBookingStack(2);
  users = await createUsers(stack);
});

afterAll(async () => {
  await stack.close();
});

beforeEach(async () => {
  await resetCalendar(stack.db);
  stack.setNow("2027-03-01T06:00:00Z");
  const created = await request(stack.app)
    .post("/api/admin/services")
    .set(bearer(users.admin))
    .send({ name: "Massage 60", durationMinutes: 60, priceCents: 6500 });
  serviceId = serviceIdOf(created);
  await request(stack.app)
    .put("/api/admin/schedule/weekly")
    .set(bearer(users.admin))
    .send({ intervals: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "21:00" })) })
    .expect(200);
});

describe("simultaneous requests", () => {
  it("12 requests for the same slot from two instances: exactly one booking, one event", async () => {
    const startsAt = paris("2027-03-02", "10:00");
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => book(i, i % 2 === 0 ? users.clientA : users.clientB, startsAt)),
    );
    expect(statuses(responses)).toEqual([201, ...Array<number>(11).fill(409)]);
    for (const response of responses.filter((r) => r.status === 409)) {
      expect(response.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "taken" });
    }
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "Booking"`)).toBe(1);
    expect(await eventTypes()).toEqual(["booking.created"]);
  });

  it("overlapping intervals (different starts, break included): only one wins", async () => {
    // 60 min + one 15-min break: every pair of these overlaps; 10:15 would not.
    const starts = ["09:00", "09:15", "09:30", "09:45", "10:00"].map((time) => paris("2027-03-02", time));
    const responses = await Promise.all(starts.map((startsAt, i) => book(i, i % 2 === 0 ? users.clientA : users.clientB, startsAt)));
    expect(statuses(responses)).toEqual([201, 409, 409, 409, 409]);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "Booking" WHERE status = 'confirmed'`)).toBe(1);
  });

  it("the same Idempotency-Key in parallel on two instances: one booking, the others replay it", async () => {
    const startsAt = paris("2027-03-02", "10:00");
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => book(i, users.clientA, startsAt, "same-key-0001")));
    expect(statuses(responses)).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(responses.map(bookingIdOf)).size).toBe(1);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "Booking"`)).toBe(1);
    expect(await eventTypes()).toEqual(["booking.created"]);
  });

  it("two reschedules to the same time: one wins, the other booking keeps its time", async () => {
    const a = bookingIdOf(await book(0, users.clientA, paris("2027-03-02", "09:00")));
    const b = bookingIdOf(await book(1, users.clientB, paris("2027-03-02", "15:00")));
    const target = paris("2027-03-02", "12:00");
    const [ra, rb] = await Promise.all([
      request(instance(0)).post(`/api/bookings/${a}/reschedule`).set(bearer(users.clientA)).send({ startsAt: target }),
      request(instance(1)).post(`/api/bookings/${b}/reschedule`).set(bearer(users.clientB)).send({ startsAt: target }),
    ]);
    expect([ra?.status, rb?.status].sort()).toEqual([200, 409]);
    const loser = ra?.status === 409 ? { id: a, token: users.clientA, at: paris("2027-03-02", "09:00") } : { id: b, token: users.clientB, at: paris("2027-03-02", "15:00") };
    expect((await request(stack.app).get(`/api/bookings/${loser.id}`).set(bearer(loser.token))).body).toMatchObject({
      booking: { startsAt: loser.at, status: "confirmed" },
    });
    expect((await eventTypes()).filter((type) => type === "booking.rescheduled")).toHaveLength(1);
  });

  it("reschedule racing cancel: a consistent end state, never a move after cancellation", async () => {
    for (let round = 0; round < 5; round += 1) {
      await resetCalendar(stack.db);
      const created = await request(stack.app).post("/api/admin/services").set(bearer(users.admin)).send({ name: "M", durationMinutes: 60, priceCents: 100 });
      serviceId = serviceIdOf(created);
      await request(stack.app).put("/api/admin/schedule/weekly").set(bearer(users.admin)).send({ intervals: [{ weekday: 2, start: "09:00", end: "21:00" }] }).expect(200);

      const id = bookingIdOf(await book(0, users.clientA, paris("2027-03-02", "09:00")));
      const [moved, cancelled] = await Promise.all([
        request(instance(round)).post(`/api/bookings/${id}/reschedule`).set(bearer(users.clientA)).send({ startsAt: paris("2027-03-02", "15:00") }),
        request(instance(round + 1)).post(`/api/bookings/${id}/cancel`).set(bearer(users.clientA)).send({}),
      ]);
      expect(cancelled?.status).toBe(200);
      const types = await eventTypes();
      if (moved?.status === 200) {
        expect(types).toEqual(["booking.created", "booking.rescheduled", "booking.cancelled"]);
      } else {
        expect(moved?.status).toBe(409);
        expect(moved?.body).toMatchObject({ code: "BOOKING_NOT_ACTIVE" });
        expect(types).toEqual(["booking.created", "booking.cancelled"]);
      }
      expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "Booking" WHERE status = 'cancelled'`)).toBe(1);
    }
  });

  it("parallel cancels: one change, one event", async () => {
    const id = bookingIdOf(await book(0, users.clientA, paris("2027-03-02", "09:00")));
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => request(instance(i)).post(`/api/bookings/${id}/cancel`).set(bearer(users.clientA)).send({})),
    );
    expect(statuses(responses)).toEqual([200, 200, 200, 200, 200, 200]);
    const changed = responses.map((response) => z.object({ changed: z.boolean() }).parse(response.body).changed);
    expect(changed.filter(Boolean)).toHaveLength(1);
    expect(await eventTypes()).toEqual(["booking.created", "booking.cancelled"]);
  });

  it("closing a day racing a booking on it: never both succeed", async () => {
    for (let round = 0; round < 5; round += 1) {
      await stack.db.query("admin", `DELETE FROM "OutboxEvent"; DELETE FROM "Booking"; DELETE FROM "ScheduleException"`);
      const [booked, closed] = await Promise.all([
        book(round, users.clientA, paris("2027-03-02", "10:00")),
        request(instance(round + 1)).put("/api/admin/schedule/exceptions/2027-03-02").set(bearer(users.admin)).send({ closed: true }),
      ]);
      const bookedOk = booked.status === 201;
      const closedOk = closed?.status === 200;
      expect(bookedOk !== closedOk).toBe(true);
      if (bookedOk) {
        expect(closed?.body).toMatchObject({ code: "SCHEDULE_CONFLICT" });
      } else {
        expect(booked.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "outside_schedule" });
      }
    }
  });
});

describe("database guard (independent of the application)", () => {
  it("the exclusion constraint rejects overlapping confirmed bookings from any writer; cancelled ones do not block", async () => {
    const client = await stack.db.connect("app");
    const insert = (startsAt: string, status: "confirmed" | "cancelled", key: string) =>
      client.query(
        `INSERT INTO "Booking" (id, "clientProfileId", "serviceId", "serviceName", "durationMinutes", "priceCents", currency,
           "startsAt", "endsAt", "blockedUntil", status, "idempotencyKey", "requestFingerprint",
           "cancelledAt", "cancelledBy", "cancelledByProfileId", "updatedAt")
         SELECT gen_random_uuid(), p.id, $1, 'M', 60, 100, 'EUR', $2::timestamptz, $2::timestamptz + interval '60 minutes',
           $2::timestamptz + interval '75 minutes', $3::"BookingStatus", $4, 'x',
           CASE WHEN $3 = 'cancelled' THEN now() END, CASE WHEN $3 = 'cancelled' THEN 'client'::"BookingActor" END,
           CASE WHEN $3 = 'cancelled' THEN p.id END, now()
         FROM "UserProfile" p WHERE p."firebaseUid" = 'uid-a'`,
        [serviceId, startsAt, status, key],
      );
    try {
      await insert("2027-03-02T09:00:00Z", "confirmed", "raw-key-0001");
      // 10:10 is inside 09:00's break (until 10:15).
      await expect(insert("2027-03-02T10:10:00Z", "confirmed", "raw-key-0002")).rejects.toMatchObject({ code: "23P01" });
      await insert("2027-03-02T09:30:00Z", "cancelled", "raw-key-0003");
      // Exactly when the break ends: allowed (one break, not two).
      await insert("2027-03-02T10:15:00Z", "confirmed", "raw-key-0004");
      // The break is exactly 15 minutes for every writer.
      await expect(
        client.query(`UPDATE "Booking" SET "blockedUntil" = "endsAt" + interval '30 minutes' WHERE "idempotencyKey" = 'raw-key-0001'`),
      ).rejects.toMatchObject({ code: "23514" });
      // End must match the snapshot duration.
      await expect(
        client.query(`UPDATE "Booking" SET "endsAt" = "endsAt" + interval '5 minutes' WHERE "idempotencyKey" = 'raw-key-0001'`),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.end();
    }
  });
});
