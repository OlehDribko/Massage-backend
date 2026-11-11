import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { localDateTimeToInstant } from "../../src/modules/schedule/zoned-time.js";
import { bearer, bookingIdOf, createUsers, insertService, resetCalendar, startBookingStack, type BookingStack } from "./helpers/booking-app.js";

// Closing and reopening dates (ScheduleClosure) against real PostgreSQL: a
// layer on top of the schedule. Closed dates take no new bookings or moves;
// existing bookings stay and are listed; reopening restores the schedule.

let stack: BookingStack;
let users: Awaited<ReturnType<typeof createUsers>>;
let serviceId: string;

const NOW = "2027-03-01T06:00:00Z"; // Monday 07:00 in Paris
const WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "09:00", end: "20:30" }));

const admin = () => bearer(users.admin);
const close = (dates: string[], token = admin()) => request(stack.app).post("/api/admin/schedule/closures").set(token).send({ dates });
const reopen = (dates: string[], token = admin()) => request(stack.app).post("/api/admin/schedule/closures/reopen").set(token).send({ dates });
const getDays = (from: string, to: string) => request(stack.app).get(`/api/admin/schedule/days?from=${from}&to=${to}`).set(admin());

const interval = z.strictObject({ start: z.string(), end: z.string() });
const daySchema = z.strictObject({
  date: z.string(),
  weekday: z.int(),
  closed: z.boolean(),
  source: z.enum(["weekly", "exception"]),
  intervals: z.array(interval),
  closure: z.strictObject({ closedAt: z.string() }).nullable(),
  effective: z.strictObject({ open: z.boolean(), intervals: z.array(interval) }),
});
const daysOf = (body: unknown) => z.object({ days: z.array(daySchema) }).parse(body).days;
const bookingsOf = (body: unknown) =>
  z
    .strictObject({
      timeZone: z.literal("Europe/Paris"),
      days: z.array(daySchema),
      bookings: z.array(z.strictObject({ bookingId: z.string(), date: z.string(), startsAt: z.string(), endsAt: z.string(), serviceName: z.string() })),
    })
    .parse(body).bookings;

const paris = (date: string, hhmm: string): string => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return localDateTimeToInstant(date, Number(h) * 60 + Number(m), "Europe/Paris").toISOString();
};

let keyCounter = 0;
const book = (token: string, startsAt: string) =>
  request(stack.app)
    .post("/api/bookings")
    .set(bearer(token))
    .set("Idempotency-Key", `closure-${String((keyCounter += 1)).padStart(8, "0")}`)
    .send({ serviceId, startsAt });

const slotsOn = async (date: string): Promise<string[]> => {
  const response = await request(stack.app).get(`/api/services/${serviceId}/availability?from=${date}&to=${date}`).expect(200);
  const parsed = z
    .object({ days: z.array(z.object({ date: z.string(), slots: z.array(z.object({ startsAt: z.string() })) })) })
    .parse(response.body);
  return parsed.days.find((day) => day.date === date)?.slots.map((slot) => slot.startsAt) ?? [];
};

beforeAll(async () => {
  stack = await startBookingStack(1);
  users = await createUsers(stack);
});

beforeEach(async () => {
  stack.setNow(NOW);
  await resetCalendar(stack.db);
  serviceId = await insertService(stack.db, { name: "Massage 60", durationMinutes: 60, priceCents: 6500 });
  await request(stack.app).put("/api/admin/schedule/weekly").set(admin()).send({ intervals: WEEK }).expect(200);
});

afterAll(async () => {
  await stack.close();
});

describe("closing dates", () => {
  it("closes several dates at once, keeps and lists their bookings, and takes no new bookings there", async () => {
    const kept = bookingIdOf(await book(users.clientA, paris("2027-03-03", "10:00")).expect(201));
    const other = bookingIdOf(await book(users.clientB, paris("2027-03-05", "10:00")).expect(201));

    const response = await close(["2027-03-03", "2027-03-04"]).expect(200);
    expect(bookingsOf(response.body)).toEqual([
      { bookingId: kept, date: "2027-03-03", startsAt: paris("2027-03-03", "10:00"), endsAt: paris("2027-03-03", "11:00"), serviceName: "Massage 60" },
    ]);
    expect(daysOf(response.body).map((day) => [day.date, day.closure !== null, day.effective.open, day.closed, day.intervals])).toEqual([
      ["2027-03-03", true, false, false, [{ start: "09:00", end: "20:30" }]],
      ["2027-03-04", true, false, false, [{ start: "09:00", end: "20:30" }]],
    ]);

    // The booking stays; no new booking or slot on a closed date; other dates unchanged.
    const own = await request(stack.app).get(`/api/bookings/${kept}`).set(bearer(users.clientA)).expect(200);
    expect(own.body).toMatchObject({ booking: { status: "confirmed" } });
    expect(await slotsOn("2027-03-04")).toEqual([]);
    expect(await slotsOn("2027-03-03")).toEqual([]);
    const refused = await book(users.clientB, paris("2027-03-04", "10:00"));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "outside_schedule" });
    expect((await slotsOn("2027-03-05")).length).toBeGreaterThan(0);
    expect(other).toBeTruthy();
  });

  it("no move onto a closed date; moving away or cancelling leaves the freed time closed", async () => {
    const id = bookingIdOf(await book(users.clientA, paris("2027-03-03", "10:00")).expect(201));
    const elsewhere = bookingIdOf(await book(users.clientB, paris("2027-03-05", "10:00")).expect(201));
    await close(["2027-03-03"]).expect(200);

    const onto = await request(stack.app).post(`/api/bookings/${elsewhere}/reschedule`).set(bearer(users.clientB)).send({ startsAt: paris("2027-03-03", "15:00") });
    expect(onto.status).toBe(409);
    expect(onto.body).toMatchObject({ code: "SLOT_UNAVAILABLE" });

    await request(stack.app).post(`/api/bookings/${id}/reschedule`).set(bearer(users.clientA)).send({ startsAt: paris("2027-03-06", "10:00") }).expect(200);
    expect(await slotsOn("2027-03-03")).toEqual([]);
    expect((await book(users.clientB, paris("2027-03-03", "10:00"))).status).toBe(409);

    await request(stack.app).post(`/api/bookings/${id}/cancel`).set(bearer(users.clientA)).send({}).expect(200);
    expect(await slotsOn("2027-03-03")).toEqual([]);
  });

  it("closing again and reopening again are safe; reopening restores the date's own schedule", async () => {
    await request(stack.app)
      .put("/api/admin/schedule/days")
      .set(admin())
      .send({ days: [{ date: "2027-03-03", intervals: [{ start: "14:00", end: "18:00" }] }, { date: "2027-03-04", closed: true }] })
      .expect(200);
    const first = await close(["2027-03-03", "2027-03-04", "2027-03-05"]).expect(200);
    const closedAt = daysOf(first.body)[0]?.closure?.closedAt;
    stack.setNow("2027-03-01T07:00:00Z");
    const again = await close(["2027-03-03"]).expect(200);
    expect(daysOf(again.body)[0]?.closure?.closedAt).toBe(closedAt);

    const reopened = await reopen(["2027-03-03", "2027-03-04", "2027-03-05"]).expect(200);
    expect(daysOf(reopened.body).map((day) => [day.date, day.closure, day.source, day.closed, day.effective])).toEqual([
      // Own hours of the date are back.
      ["2027-03-03", null, "exception", false, { open: true, intervals: [{ start: "14:00", end: "18:00" }] }],
      // Reopening does not promise a working day: the date's own exception has no hours.
      ["2027-03-04", null, "exception", true, { open: false, intervals: [] }],
      // Back to the weekly rule.
      ["2027-03-05", null, "weekly", false, { open: true, intervals: [{ start: "09:00", end: "20:30" }] }],
    ]);
    await reopen(["2027-03-03"]).expect(200);
    expect(await slotsOn("2027-03-03")).toContain(paris("2027-03-03", "14:00"));
  });

  it("the month view distinguishes the schedule, the closure and what can be booked", async () => {
    await close(["2027-03-10"]).expect(200);
    const days = daysOf((await getDays("2027-03-01", "2027-03-31").expect(200)).body);
    expect(days).toHaveLength(31);
    expect(days.filter((day) => day.closure !== null).map((day) => day.date)).toEqual(["2027-03-10"]);
    const closed = days.find((day) => day.date === "2027-03-10");
    expect(closed).toMatchObject({ closed: false, source: "weekly", effective: { open: false, intervals: [] } });
    expect(days.find((day) => day.date === "2027-03-11")).toMatchObject({ closure: null, effective: { open: true } });
  });

  it("other schedule changes keep their SCHEDULE_CONFLICT checks; a closure does not count as a conflict", async () => {
    const id = bookingIdOf(await book(users.clientA, paris("2027-03-03", "10:00")).expect(201));
    await close(["2027-03-03"]).expect(200);
    // Editing the hours of the closed date under its booking is still refused.
    const conflict = await request(stack.app)
      .put("/api/admin/schedule/days")
      .set(admin())
      .send({ days: [{ date: "2027-03-03", intervals: [{ start: "14:00", end: "18:00" }] }] });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "SCHEDULE_CONFLICT", conflicts: [{ bookingId: id }] });
    // The weekly schedule can still change (the booking fits it).
    await request(stack.app).put("/api/admin/schedule/weekly").set(admin()).send({ intervals: WEEK }).expect(200);
  });

  it("closing while bookings arrive at the same time: each booking either is listed by the closure or refused", async () => {
    const starts = ["10:00", "12:00", "14:00", "16:00"].map((hhmm) => paris("2027-03-12", hhmm));
    const [closure, ...bookings] = await Promise.all([close(["2027-03-12"]), ...starts.map((startsAt) => book(users.clientA, startsAt))]);
    expect(closure?.status).toBe(200);
    const listed = new Set(bookingsOf(closure?.body).map((booking) => booking.bookingId));
    for (const response of bookings) {
      if (response.status === 201) {
        // Created before the closure took the calendar lock: kept and listed (never created after it).
        expect(listed.has(bookingIdOf(response))).toBe(true);
      } else {
        expect([409, 503]).toContain(response.status);
      }
    }
    expect((await book(users.clientA, paris("2027-03-12", "18:00"))).status).toBe(409);
  });

  it("validates the request: 1–62 distinct dates; admins only; all or nothing", async () => {
    const tooMany = Array.from({ length: 63 }, (_, index) => new Date(Date.parse("2027-03-01T00:00:00Z") + index * 86_400_000).toISOString().slice(0, 10));
    for (const body of [{ dates: [] }, { dates: ["2027-03-03", "2027-03-03"] }, { dates: ["2027-02-30"] }, { dates: tooMany }, {}, { dates: ["2027-03-03"], extra: 1 }]) {
      const response = await request(stack.app).post("/api/admin/schedule/closures").set(admin()).send(body);
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await close(tooMany.slice(0, 62))).status).toBe(200);
    expect((await close(["2027-03-03"], bearer(users.clientA))).status).toBe(403);
    expect((await reopen(["2027-03-03"], bearer(users.clientA))).status).toBe(403);
    expect((await request(stack.app).post("/api/admin/schedule/closures").send({ dates: ["2027-03-03"] })).status).toBe(401);
  });
});
