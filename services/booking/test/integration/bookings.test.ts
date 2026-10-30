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

// Catalogue, schedule, availability and the booking lifecycle over HTTP
// against real PostgreSQL (see helpers/booking-app.ts).

let stack: BookingStack;
let users: Awaited<ReturnType<typeof createUsers>>;

const BASE_NOW = "2027-03-01T06:00:00Z"; // Monday 07:00 in Paris (UTC+1)
const H = 3_600_000;

const paris = (date: string, hhmm: string): string => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return localDateTimeToInstant(date, Number(h) * 60 + Number(m), "Europe/Paris").toISOString();
};

const WEEKLY = {
  intervals: [1, 2, 3, 4, 5, 6].flatMap((weekday) => [
    { weekday, start: "09:00", end: "13:00" },
    { weekday, start: "14:00", end: "21:00" },
  ]),
};

const asAdmin = () => bearer(users.admin);

const createService = async (body: object = { name: "Massage 60", durationMinutes: 60, priceCents: 6500 }) => {
  const response = await request(stack.app).post("/api/admin/services").set(asAdmin()).send(body);
  expect(response.status).toBe(201);
  return serviceIdOf(response);
};

const setWeekly = (body: object = WEEKLY) => request(stack.app).put("/api/admin/schedule/weekly").set(asAdmin()).send(body);

let keyCounter = 0;
const book = (token: string, serviceId: string, startsAt: string, key = `key-${String((keyCounter += 1)).padStart(8, "0")}`, app = stack.app) =>
  request(app).post("/api/bookings").set(bearer(token)).set("Idempotency-Key", key).send({ serviceId, startsAt });

const reschedule = (token: string, id: string, startsAt: string, app = stack.app) =>
  request(app).post(`/api/bookings/${id}/reschedule`).set(bearer(token)).send({ startsAt });

const cancel = (token: string, id: string, app = stack.app) =>
  request(app).post(`/api/bookings/${id}/cancel`).set(bearer(token)).send({});

const availability = (serviceId: string, from: string, to = from) =>
  request(stack.app).get(`/api/services/${serviceId}/availability?from=${from}&to=${to}`);

const slotsOn = async (serviceId: string, date: string): Promise<string[]> => {
  const response = await availability(serviceId, date);
  expect(response.status).toBe(200);
  const body: unknown = response.body;
  const parsed = z
    .object({ days: z.array(z.object({ date: z.string(), slots: z.array(z.object({ startsAt: z.string() })) })) })
    .parse(body);
  return parsed.days.find((day) => day.date === date)?.slots.map((slot) => slot.startsAt) ?? [];
};

const events = async (): Promise<{ type: string; dedupeKey: string; schemaVersion: number }[]> => {
  const result = await stack.db.query("admin", `SELECT type, "dedupeKey", "schemaVersion" FROM "OutboxEvent" ORDER BY position`);
  const rows: unknown = result.rows;
  return z.array(z.object({ type: z.string(), dedupeKey: z.string(), schemaVersion: z.number() })).parse(rows);
};

beforeAll(async () => {
  stack = await startBookingStack();
  users = await createUsers(stack);
});

afterAll(async () => {
  await stack.close();
});

beforeEach(async () => {
  await resetCalendar(stack.db);
  stack.setNow(BASE_NOW);
});

describe("access: guests, clients and admins", () => {
  it("guests read the catalogue and availability without a token; administration needs a verified admin", async () => {
    const serviceId = await createService();
    expect((await setWeekly()).status).toBe(200);

    const list = await request(stack.app).get("/api/services");
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      services: [{ id: serviceId, name: "Massage 60", description: null, durationMinutes: 60, priceCents: 6500, currency: "EUR" }],
    });
    expect((await availability(serviceId, "2027-03-02")).status).toBe(200);

    expect((await request(stack.app).post("/api/admin/services").send({})).status).toBe(401);
    for (const token of [users.clientA, users.guest, users.unverified]) {
      const response = await request(stack.app)
        .post("/api/admin/services")
        .set(bearer(token))
        .send({ name: "x", durationMinutes: 30, priceCents: 1 });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "FORBIDDEN" });
      expect((await request(stack.app).put("/api/admin/schedule/weekly").set(bearer(token)).send(WEEKLY)).status).toBe(403);
      expect((await request(stack.app).get("/api/admin/bookings?date=2027-03-02").set(bearer(token))).status).toBe(403);
    }
    expect((await request(stack.app).patch(`/api/admin/services/${serviceId}`).set(bearer(users.clientA)).send({ priceCents: 1 })).status).toBe(403);
  });

  it("only a booking-ready client books; guests, unverified, incomplete profiles and admins are refused", async () => {
    const serviceId = await createService();
    await setWeekly();
    const startsAt = paris("2027-03-02", "09:00");

    const expectations: [string, string[]][] = [
      [users.guest, ["anonymous_session", "email_not_verified", "name_missing", "phone_missing"]],
      [users.unverified, ["email_not_verified"]],
      [users.incomplete, ["name_missing", "phone_missing"]],
      [users.admin, ["not_a_client"]],
    ];
    for (const [token, blockers] of expectations) {
      const response = await book(token, serviceId, startsAt);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "BOOKING_NOT_READY", blockers });
    }
    expect((await request(stack.app).post("/api/bookings").send({ serviceId, startsAt })).status).toBe(401);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "Booking"`)).toBe(0);
  });

  it("a client sees and changes only their own bookings; someone else's is 404", async () => {
    const serviceId = await createService();
    await setWeekly();
    const own = bookingIdOf(await book(users.clientA, serviceId, paris("2027-03-02", "09:00")));

    expect((await request(stack.app).get(`/api/bookings/${own}`).set(bearer(users.clientB))).status).toBe(404);
    expect((await cancel(users.clientB, own)).status).toBe(404);
    expect((await reschedule(users.clientB, own, paris("2027-03-02", "11:00"))).status).toBe(404);
    expect((await request(stack.app).get("/api/bookings").set(bearer(users.clientB))).body).toEqual({ bookings: [] });
    expect((await request(stack.app).get(`/api/bookings/${own}`).set(bearer(users.clientA))).status).toBe(200);
    // Admin routes are separate; a client cannot use them for someone else.
    expect((await request(stack.app).get(`/api/admin/bookings/${own}`).set(bearer(users.clientB))).status).toBe(403);
  });
});

describe("catalogue", () => {
  it("validates money in whole cents and positive minutes; rejects unknown fields", async () => {
    for (const body of [
      { name: "x", durationMinutes: 60, priceCents: 65.5 },
      { name: "x", durationMinutes: 0, priceCents: 100 },
      { name: "x", durationMinutes: -30, priceCents: 100 },
      { name: "x", durationMinutes: 60, priceCents: -1 },
      { name: "", durationMinutes: 60, priceCents: 100 },
      { name: "x", durationMinutes: 60, priceCents: 100, currency: "USD" },
      { name: "x", durationMinutes: 60, priceCents: 100, imageUrl: "https://example.invalid/a.jpg" },
    ]) {
      const response = await request(stack.app).post("/api/admin/services").set(asAdmin()).send(body);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("bookings keep the price, duration and name of the moment they were created", async () => {
    const serviceId = await createService({ name: "Deep tissue", durationMinutes: 60, priceCents: 7000 });
    await setWeekly();
    const id = bookingIdOf(await book(users.clientA, serviceId, paris("2027-03-02", "09:00")));

    const edit = await request(stack.app)
      .patch(`/api/admin/services/${serviceId}`)
      .set(asAdmin())
      .send({ name: "Deep tissue (new)", durationMinutes: 90, priceCents: 9900 });
    expect(edit.status).toBe(200);

    const moved = await reschedule(users.clientA, id, paris("2027-03-03", "10:00"));
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      booking: {
        service: { id: serviceId, name: "Deep tissue", durationMinutes: 60, priceCents: 7000, currency: "EUR" },
        startsAt: paris("2027-03-03", "10:00"),
        endsAt: paris("2027-03-03", "11:00"),
        payment: "on_site",
      },
    });
  });

  it("deleting an unused service removes it; a booked one is archived: not bookable, history kept", async () => {
    const unused = await createService({ name: "Unused", durationMinutes: 30, priceCents: 3000 });
    expect((await request(stack.app).delete(`/api/admin/services/${unused}`).set(asAdmin())).body).toEqual({ outcome: "deleted" });
    expect((await request(stack.app).get(`/api/services/${unused}`)).status).toBe(404);

    const used = await createService();
    await setWeekly();
    const id = bookingIdOf(await book(users.clientA, used, paris("2027-03-02", "09:00")));
    const removed = await request(stack.app).delete(`/api/admin/services/${used}`).set(asAdmin());
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ outcome: "archived", service: { id: used, bookable: false } });

    expect((await request(stack.app).get("/api/services")).body).toEqual({ services: [] });
    expect((await request(stack.app).get(`/api/services/${used}`)).status).toBe(404);
    expect((await availability(used, "2027-03-02")).status).toBe(404);
    const refused = await book(users.clientB, used, paris("2027-03-02", "11:00"));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "SERVICE_NOT_BOOKABLE" });
    // The existing booking stays intact and can still be moved and cancelled.
    expect((await reschedule(users.clientA, id, paris("2027-03-02", "11:00"))).status).toBe(200);
    expect((await request(stack.app).get(`/api/bookings/${id}`).set(bearer(users.clientA))).body).toMatchObject({
      booking: { status: "confirmed", service: { name: "Massage 60", priceCents: 6500 } },
    });
    // Admin can make it bookable again.
    expect((await request(stack.app).patch(`/api/admin/services/${used}`).set(asAdmin()).send({ bookable: true })).body).toMatchObject({
      service: { bookable: true, archivedAt: null },
    });
  });
});

describe("schedule and availability", () => {
  it("weekly intervals, days off and date exceptions shape the offered starts", async () => {
    const serviceId = await createService();
    await setWeekly();

    const tuesday = await slotsOn(serviceId, "2027-03-02");
    expect(tuesday[0]).toBe(paris("2027-03-02", "09:00"));
    expect(tuesday).toContain(paris("2027-03-02", "12:00"));
    expect(tuesday).not.toContain(paris("2027-03-02", "12:15")); // lunch 13:00–14:00
    expect(tuesday.at(-1)).toBe(paris("2027-03-02", "19:00")); // latest start
    expect(await slotsOn(serviceId, "2027-03-07")).toEqual([]); // Sunday: no weekly interval

    const closed = await request(stack.app).put("/api/admin/schedule/exceptions/2027-03-03").set(asAdmin()).send({ closed: true });
    expect(closed.body).toEqual({ date: "2027-03-03", closed: true, intervals: [] });
    expect(await slotsOn(serviceId, "2027-03-03")).toEqual([]);

    await request(stack.app).put("/api/admin/schedule/exceptions/2027-03-07").set(asAdmin()).send({ intervals: [{ start: "10:00", end: "11:30" }] }).expect(200);
    expect(await slotsOn(serviceId, "2027-03-07")).toEqual([
      paris("2027-03-07", "10:00"),
      paris("2027-03-07", "10:15"),
      paris("2027-03-07", "10:30"),
    ]);

    await request(stack.app).delete("/api/admin/schedule/exceptions/2027-03-03").set(asAdmin()).expect(200);
    expect((await slotsOn(serviceId, "2027-03-03")).length).toBeGreaterThan(0);

    const view = await request(stack.app).get("/api/admin/schedule").set(asAdmin());
    expect(view.body).toMatchObject({ timeZone: "Europe/Paris", exceptions: [{ date: "2027-03-07", closed: false }] });
  });

  it("availability keeps one 15-minute break between bookings and reveals nothing about them", async () => {
    const serviceId = await createService();
    await setWeekly();
    await book(users.clientA, serviceId, paris("2027-03-02", "10:00")).expect(201);

    const slots = await slotsOn(serviceId, "2027-03-02");
    expect(slots).not.toContain(paris("2027-03-02", "09:00")); // would end 10:00, no break before 10:00
    expect(slots).not.toContain(paris("2027-03-02", "11:00")); // inside the break after 11:00
    expect(slots).toContain(paris("2027-03-02", "11:15")); // exactly when the break ends

    const raw = (await availability(serviceId, "2027-03-02")).text;
    for (const secret of ["anna@example.invalid", "Anna", "+33612345678", "bookingId", "clientProfileId"]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("the grid restarts when the break ends: after a session ending 14:10, 14:25 is bookable (not rounded to 14:30)", async () => {
    const short = await createService({ name: "Massage 55", durationMinutes: 55, priceCents: 6000 });
    const hour = await createService();
    await setWeekly();
    // Wednesday without lunch: 09:00–18:00.
    await request(stack.app).put("/api/admin/schedule/exceptions/2027-03-03").set(asAdmin()).send({ intervals: [{ start: "09:00", end: "18:00" }] }).expect(200);
    // 13:15 + 55 min = 14:10; the break ends at 14:25.
    await book(users.clientA, short, paris("2027-03-03", "13:15")).expect(201);

    const slots = await slotsOn(hour, "2027-03-03");
    expect(slots).toContain(paris("2027-03-03", "14:25"));
    expect(slots).toContain(paris("2027-03-03", "14:40"));
    expect(slots).not.toContain(paris("2027-03-03", "14:15"));
    expect(slots).not.toContain(paris("2027-03-03", "14:30"));

    // Rescheduling and creating use the same rule.
    const other = bookingIdOf(await book(users.clientB, hour, paris("2027-03-02", "09:00")));
    const tooEarly = await reschedule(users.clientB, other, paris("2027-03-03", "14:20"));
    expect(tooEarly.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "taken" });
    const moved = await reschedule(users.clientB, other, paris("2027-03-03", "14:25"));
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ booking: { startsAt: paris("2027-03-03", "14:25"), endsAt: paris("2027-03-03", "15:25") } });
    // Next free start after 15:25 + 15 = 15:40.
    expect(await slotsOn(hour, "2027-03-03")).toContain(paris("2027-03-03", "15:40"));
    const overlapping = await book(users.clientA, hour, paris("2027-03-03", "15:30"));
    expect(overlapping.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "taken" });
    expect((await book(users.clientA, hour, paris("2027-03-03", "15:40"))).status).toBe(201);
  });

  it("15 minutes is the minimum break: after a session ending 14:10, both 14:25 and later 14:40 can be booked", async () => {
    const short = await createService({ name: "Massage 55", durationMinutes: 55, priceCents: 6000 });
    const hour = await createService();
    await setWeekly();
    for (const date of ["2027-03-03", "2027-03-04"]) {
      await request(stack.app).put(`/api/admin/schedule/exceptions/${date}`).set(asAdmin()).send({ intervals: [{ start: "09:00", end: "18:00" }] }).expect(200);
      await book(users.clientA, short, paris(date, "13:15")).expect(201); // ends 14:10
    }
    // Exactly at the end of the minimum break.
    expect((await book(users.clientB, hour, paris("2027-03-03", "14:25"))).status).toBe(201);
    // With a longer free gap (30 min), chosen by the client.
    const later = await book(users.clientB, hour, paris("2027-03-04", "14:40"));
    expect(later.status).toBe(201);
    expect(later.body).toMatchObject({ booking: { startsAt: paris("2027-03-04", "14:40"), endsAt: paris("2027-03-04", "15:40") } });
  });

  it("lead time 12 h and horizon: today + 45 days until local midnight", async () => {
    const serviceId = await createService();
    await setWeekly();
    stack.setNow("2027-03-01T06:00:00Z"); // 07:00 Paris → earliest start 19:00 today
    expect(await slotsOn(serviceId, "2027-03-01")).toEqual([paris("2027-03-01", "19:00")]);

    const tooSoon = await book(users.clientA, serviceId, paris("2027-03-01", "18:45"));
    expect(tooSoon.status).toBe(409);
    expect(tooSoon.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "too_soon" });
    expect((await book(users.clientA, serviceId, paris("2027-03-01", "19:00"))).status).toBe(201);

    // Horizon: last day 2027-04-15 (Thursday), not 04-16.
    expect((await slotsOn(serviceId, "2027-04-15")).length).toBeGreaterThan(0);
    expect(await slotsOn(serviceId, "2027-04-16")).toEqual([]);
    const beyond = await book(users.clientB, serviceId, paris("2027-04-16", "09:00"));
    expect(beyond.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "beyond_horizon" });
    expect((await book(users.clientB, serviceId, paris("2027-04-15", "19:00"))).status).toBe(201);
  });

  it("refuses starts outside the schedule, off the 15-minute grid or after 19:00", async () => {
    const serviceId = await createService({ name: "Long", durationMinutes: 90, priceCents: 9000 });
    await setWeekly();
    for (const time of ["08:45", "12:00", "09:10", "19:15", "13:30"]) {
      const response = await book(users.clientA, serviceId, paris("2027-03-02", time));
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "outside_schedule" });
    }
    // 90 minutes at 19:00 ends 20:30, inside 14:00–21:00.
    expect((await book(users.clientA, serviceId, paris("2027-03-02", "19:00"))).status).toBe(201);
  });

  it("a schedule change that would strand an active booking is refused until the admin resolves it", async () => {
    const serviceId = await createService();
    await setWeekly();
    const id = bookingIdOf(await book(users.clientA, serviceId, paris("2027-03-02", "15:00")));

    const morningsOnly = await setWeekly({ intervals: [{ weekday: 2, start: "09:00", end: "13:00" }] });
    expect(morningsOnly.status).toBe(409);
    expect(morningsOnly.body).toMatchObject({
      code: "SCHEDULE_CONFLICT",
      conflicts: [{ bookingId: id, startsAt: paris("2027-03-02", "15:00"), serviceName: "Massage 60" }],
    });
    const dayOff = await request(stack.app).put("/api/admin/schedule/exceptions/2027-03-02").set(asAdmin()).send({ closed: true });
    expect(dayOff.status).toBe(409);
    // Nothing changed: the booking is still confirmed and the schedule still offers the afternoon.
    expect((await request(stack.app).get(`/api/bookings/${id}`).set(bearer(users.clientA))).body).toMatchObject({ booking: { status: "confirmed" } });
    expect(await slotsOn(serviceId, "2027-03-03")).toContain(paris("2027-03-03", "15:00"));

    // A change that keeps the booking inside its interval is fine.
    await request(stack.app).put("/api/admin/schedule/exceptions/2027-03-02").set(asAdmin()).send({ intervals: [{ start: "14:30", end: "17:00" }] }).expect(200);

    // After the admin cancels it, the day can be closed.
    await request(stack.app).post(`/api/admin/bookings/${id}/cancel`).set(asAdmin()).send({ reason: "Studio closed" }).expect(200);
    await request(stack.app).put("/api/admin/schedule/exceptions/2027-03-02").set(asAdmin()).send({ closed: true }).expect(200);
  });
});

describe("daylight saving time (Europe/Paris)", () => {
  it("09:00 local is 08:00Z before and 07:00Z after the spring change; 09:00 is 08:00Z after the autumn change", async () => {
    const serviceId = await createService();
    await setWeekly({ intervals: [6, 7].map((weekday) => ({ weekday, start: "09:00", end: "11:00" })) });

    stack.setNow("2027-03-20T08:00:00Z");
    expect((await slotsOn(serviceId, "2027-03-27"))[0]).toBe("2027-03-27T08:00:00.000Z");
    expect((await slotsOn(serviceId, "2027-03-28"))[0]).toBe("2027-03-28T07:00:00.000Z");
    const spring = await book(users.clientA, serviceId, "2027-03-28T07:00:00Z");
    expect(spring.status).toBe(201);
    expect(spring.body).toMatchObject({ booking: { startsAt: "2027-03-28T07:00:00.000Z", endsAt: "2027-03-28T08:00:00.000Z" } });

    stack.setNow("2027-10-20T08:00:00Z");
    expect((await slotsOn(serviceId, "2027-10-30"))[0]).toBe("2027-10-30T07:00:00.000Z");
    expect((await slotsOn(serviceId, "2027-10-31"))[0]).toBe("2027-10-31T08:00:00.000Z");
    // 08:00Z on 10-30 would be 10:00 local: on the grid; 09:00 local-of-summer (07:00Z) on 10-31 is 08:00 local: refused.
    const wrongOffset = await book(users.clientA, serviceId, "2027-10-31T07:00:00Z");
    expect(wrongOffset.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "outside_schedule" });
    expect((await book(users.clientA, serviceId, "2027-10-31T08:00:00Z")).status).toBe(201);
  });
});

describe("creating a booking", () => {
  it("server sets end, price and duration; client-supplied values are rejected", async () => {
    const serviceId = await createService();
    await setWeekly();
    const tampered = await request(stack.app)
      .post("/api/bookings")
      .set(bearer(users.clientA))
      .set("Idempotency-Key", "tamper-0001")
      .send({ serviceId, startsAt: paris("2027-03-02", "09:00"), priceCents: 1, endsAt: paris("2027-03-02", "09:05") });
    expect(tampered.status).toBe(400);

    const created = await book(users.clientA, serviceId, paris("2027-03-02", "09:00"));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      booking: {
        status: "confirmed",
        phase: "upcoming",
        timeZone: "Europe/Paris",
        startsAt: paris("2027-03-02", "09:00"),
        endsAt: paris("2027-03-02", "10:00"),
        service: { id: serviceId, priceCents: 6500, durationMinutes: 60, currency: "EUR" },
        allowedActions: { reschedule: true, cancel: true },
        history: [{ type: "created" }],
      },
    });
    expect(created.text).not.toMatch(/email.*sent|notification/i);
  });

  it("is idempotent per Idempotency-Key: a retry returns the same booking, no second booking or event", async () => {
    const serviceId = await createService();
    await setWeekly();
    const startsAt = paris("2027-03-02", "09:00");

    const first = await book(users.clientA, serviceId, startsAt, "retry-key-0001");
    const retries = await Promise.all([1, 2, 3].map(() => book(users.clientA, serviceId, startsAt, "retry-key-0001")));
    expect(first.status).toBe(201);
    for (const retry of retries) {
      expect(retry.status).toBe(200);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect(bookingIdOf(retry)).toBe(bookingIdOf(first));
    }
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "Booking"`)).toBe(1);
    expect(await events()).toHaveLength(1);

    const reused = await book(users.clientA, serviceId, paris("2027-03-02", "11:00"), "retry-key-0001");
    expect(reused.status).toBe(422);
    expect(reused.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    // Keys are per client: another client may use the same key.
    expect((await book(users.clientB, serviceId, paris("2027-03-02", "11:00"), "retry-key-0001")).status).toBe(201);

    const missing = await request(stack.app).post("/api/bookings").set(bearer(users.clientA)).send({ serviceId, startsAt });
    expect(missing.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    const invalid = await book(users.clientA, serviceId, startsAt, "short");
    expect(invalid.body).toMatchObject({ code: "IDEMPOTENCY_KEY_INVALID" });
  });
});

describe("rescheduling", () => {
  it("moves the booking atomically and records the history and one event", async () => {
    const serviceId = await createService();
    await setWeekly();
    const id = bookingIdOf(await book(users.clientA, serviceId, paris("2027-03-02", "09:00")));
    const blocker = bookingIdOf(await book(users.clientB, serviceId, paris("2027-03-02", "15:00")));

    // Target overlaps B's booking (or its break): refused, A keeps the old time.
    const taken = await reschedule(users.clientA, id, paris("2027-03-02", "14:00"));
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "taken" });
    expect((await request(stack.app).get(`/api/bookings/${id}`).set(bearer(users.clientA))).body).toMatchObject({
      booking: { startsAt: paris("2027-03-02", "09:00"), history: [{ type: "created" }] },
    });

    const moved = await reschedule(users.clientA, id, paris("2027-03-02", "16:30"));
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      changed: true,
      booking: {
        id,
        startsAt: paris("2027-03-02", "16:30"),
        history: [
          { type: "created" },
          { type: "rescheduled", from: { startsAt: paris("2027-03-02", "09:00") }, to: { startsAt: paris("2027-03-02", "16:30") } },
        ],
      },
    });
    // The old time is free again.
    expect(await slotsOn(serviceId, "2027-03-02")).toContain(paris("2027-03-02", "09:00"));

    // A repeat of the same request changes nothing and adds no event.
    const repeat = await reschedule(users.clientA, id, paris("2027-03-02", "16:30"));
    expect(repeat.body).toMatchObject({ changed: false });
    expect((await events()).map((event) => event.type)).toEqual(["booking.created", "booking.created", "booking.rescheduled"]);
    expect(blocker).not.toBe(id);
  });

  it("allowed only while strictly more than 12 h remain; the new start also needs 12 h", async () => {
    const serviceId = await createService();
    await setWeekly();
    const startsAt = paris("2027-03-02", "19:00");
    const id = bookingIdOf(await book(users.clientA, serviceId, startsAt));

    stack.setNow(new Date(Date.parse(startsAt) - 12 * H).toISOString());
    const exactly = await reschedule(users.clientA, id, paris("2027-03-03", "10:00"));
    expect(exactly.status).toBe(409);
    expect(exactly.body).toMatchObject({ code: "RESCHEDULE_WINDOW_CLOSED" });

    stack.setNow(new Date(Date.parse(startsAt) - 12 * H - 60_000).toISOString());
    const tooSoonTarget = await reschedule(users.clientA, id, paris("2027-03-02", "17:00"));
    expect(tooSoonTarget.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "too_soon" });
    expect((await reschedule(users.clientA, id, paris("2027-03-03", "10:00"))).status).toBe(200);
  });

  it("a cancelled booking cannot be moved", async () => {
    const serviceId = await createService();
    await setWeekly();
    const id = bookingIdOf(await book(users.clientA, serviceId, paris("2027-03-02", "09:00")));
    await cancel(users.clientA, id).expect(200);
    const response = await reschedule(users.clientA, id, paris("2027-03-02", "11:00"));
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "BOOKING_NOT_ACTIVE" });
  });
});

describe("cancelling", () => {
  it("client: any time before the start (even a minute before), never from the start on; repeats add nothing", async () => {
    const serviceId = await createService();
    await setWeekly();
    const startsAt = paris("2027-03-02", "19:00");
    const late = bookingIdOf(await book(users.clientA, serviceId, startsAt));
    const started = bookingIdOf(await book(users.clientB, serviceId, paris("2027-03-02", "09:00")));

    stack.setNow(new Date(Date.parse(startsAt) - 60_000).toISOString());
    const cancelled = await cancel(users.clientA, late);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      changed: true,
      booking: { status: "cancelled", phase: "cancelled", cancellation: { by: "client", reason: null } },
    });
    expect((await cancel(users.clientA, late)).body).toMatchObject({ changed: false });

    stack.setNow(paris("2027-03-02", "09:00"));
    const atStart = await cancel(users.clientB, started);
    expect(atStart.status).toBe(409);
    expect(atStart.body).toMatchObject({ code: "CANCELLATION_WINDOW_CLOSED" });

    expect((await events()).filter((event) => event.type === "booking.cancelled")).toHaveLength(1);
    // Cancelled bookings stay in the client's history.
    expect((await request(stack.app).get("/api/bookings").set(bearer(users.clientA))).body).toMatchObject({
      bookings: [{ id: late, status: "cancelled" }],
    });
  });

  it("frees the time for others", async () => {
    const serviceId = await createService();
    await setWeekly();
    const startsAt = paris("2027-03-02", "09:00");
    const id = bookingIdOf(await book(users.clientA, serviceId, startsAt));
    expect((await book(users.clientB, serviceId, startsAt)).status).toBe(409);
    await cancel(users.clientA, id).expect(200);
    expect(await slotsOn(serviceId, "2027-03-02")).toContain(startsAt);
    expect((await book(users.clientB, serviceId, startsAt)).status).toBe(201);
  });

  it("admin: lists a day with client contacts, cancels a future booking with an optional reason, not a started one", async () => {
    const serviceId = await createService();
    await setWeekly();
    const future = bookingIdOf(await book(users.clientA, serviceId, paris("2027-03-02", "15:00")));
    const morning = bookingIdOf(await book(users.clientB, serviceId, paris("2027-03-02", "09:00")));

    const day = await request(stack.app).get("/api/admin/bookings?date=2027-03-02").set(asAdmin());
    expect(day.status).toBe(200);
    expect(day.body).toMatchObject({
      date: "2027-03-02",
      bookings: [
        { id: morning, client: { name: "Boris Client", email: "boris@example.invalid", phone: "+33698765432" } },
        { id: future, client: { name: "Anna Client" } },
      ],
    });
    expect((await request(stack.app).get("/api/admin/bookings").set(asAdmin())).status).toBe(400);

    const withoutReason = await request(stack.app).post(`/api/admin/bookings/${morning}/cancel`).set(asAdmin()).send({});
    expect(withoutReason.body).toMatchObject({ changed: true, booking: { cancellation: { by: "admin", reason: null } } });

    stack.setNow(paris("2027-03-02", "15:30"));
    const started = await request(stack.app).post(`/api/admin/bookings/${future}/cancel`).set(asAdmin()).send({ reason: "late" });
    expect(started.status).toBe(409);
    expect(started.body).toMatchObject({ code: "CANCELLATION_WINDOW_CLOSED" });
    expect((await request(stack.app).get(`/api/admin/bookings/${future}`).set(asAdmin())).body).toMatchObject({
      booking: { status: "confirmed", phase: "in_progress" },
    });
  });
});

describe("outbox", () => {
  it("writes one versioned event per change with what a future email needs", async () => {
    const serviceId = await createService();
    await setWeekly();
    const id = bookingIdOf(await book(users.clientA, serviceId, paris("2027-03-02", "09:00")));
    await reschedule(users.clientA, id, paris("2027-03-02", "11:00")).expect(200);
    await request(stack.app).post(`/api/admin/bookings/${id}/cancel`).set(asAdmin()).send({ reason: "Illness" }).expect(200);

    const result = await stack.db.query("admin", `SELECT id, type, "schemaVersion", "aggregateId", "dedupeKey", payload FROM "OutboxEvent" ORDER BY position`);
    const rows: unknown = result.rows;
    const parsed = z
      .array(
        z.object({
          id: z.uuid(),
          type: z.string(),
          schemaVersion: z.literal(1),
          aggregateId: z.literal(id),
          dedupeKey: z.string(),
          payload: z.record(z.string(), z.unknown()),
        }),
      )
      .parse(rows);
    expect(parsed.map((event) => event.type)).toEqual(["booking.created", "booking.rescheduled", "booking.cancelled"]);
    expect(parsed[0]?.dedupeKey).toBe(`booking.created:${id}`);
    expect(parsed[0]?.payload).toMatchObject({
      bookingId: id,
      timeZone: "Europe/Paris",
      startsAt: paris("2027-03-02", "09:00"),
      service: { name: "Massage 60", priceCents: 6500, currency: "EUR" },
      client: { name: "Anna Client", email: "anna@example.invalid", phone: "+33612345678" },
      actor: { role: "client" },
    });
    expect(parsed[1]?.payload).toMatchObject({ previous: { startsAt: paris("2027-03-02", "09:00") }, startsAt: paris("2027-03-02", "11:00") });
    expect(parsed[2]?.payload).toMatchObject({ status: "cancelled", actor: { role: "admin" }, cancellation: { by: "admin", reason: "Illness" } });
  });

  it("is atomic with the booking: if the event cannot be written, the booking is not created", async () => {
    const serviceId = await createService();
    await setWeekly();
    await stack.db.query("admin", `ALTER TABLE "OutboxEvent" ADD CONSTRAINT "test_reject_all" CHECK (false) NOT VALID`);
    try {
      const response = await book(users.clientA, serviceId, paris("2027-03-02", "09:00"));
      expect(response.status).toBe(500);
    } finally {
      await stack.db.query("admin", `ALTER TABLE "OutboxEvent" DROP CONSTRAINT "test_reject_all"`);
    }
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "Booking"`)).toBe(0);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "OutboxEvent"`)).toBe(0);
    // A refused request (slot taken) writes no event either.
    await book(users.clientA, serviceId, paris("2027-03-02", "09:00")).expect(201);
    await book(users.clientB, serviceId, paris("2027-03-02", "09:00")).expect(409);
    expect(await events()).toHaveLength(1);
  });
});
