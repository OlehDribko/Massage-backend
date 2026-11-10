import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { localDateTimeToInstant } from "../../src/modules/schedule/zoned-time.js";
import { bearer, createUsers, insertService, resetCalendar, startBookingStack, type BookingStack } from "./helpers/booking-app.js";

// The hours of a week or a month at once (GET/PUT /api/admin/schedule/days)
// against real PostgreSQL: different hours on each date, closed dates, back to
// the weekly rule, all or nothing on conflicts.

let stack: BookingStack;
let users: Awaited<ReturnType<typeof createUsers>>;
let serviceId: string;

const NOW = "2027-03-01T06:00:00Z"; // Monday 07:00 in Paris
const WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "09:00", end: "20:30" }));

const admin = () => bearer(users.admin);
const putDays = (days: unknown[], token = admin()) => request(stack.app).put("/api/admin/schedule/days").set(token).send({ days });
const getDays = (from: string, to: string, token = admin()) =>
  request(stack.app).get(`/api/admin/schedule/days?from=${from}&to=${to}`).set(token);

const daySchema = z.strictObject({
  date: z.string(),
  weekday: z.int(),
  closed: z.boolean(),
  source: z.enum(["weekly", "exception"]),
  intervals: z.array(z.strictObject({ start: z.string(), end: z.string() })),
  closure: z.strictObject({ closedAt: z.string() }).nullable(),
  effective: z.strictObject({ open: z.boolean(), intervals: z.array(z.strictObject({ start: z.string(), end: z.string() })) }),
});
const daysOf = (body: unknown) => z.strictObject({ timeZone: z.literal("Europe/Paris"), days: z.array(daySchema) }).parse(body).days;

const dateAfter = (first: string, days: number): string =>
  new Date(Date.parse(`${first}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const paris = (date: string, hhmm: string): string => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return localDateTimeToInstant(date, Number(h) * 60 + Number(m), "Europe/Paris").toISOString();
};

const slotsOn = async (date: string): Promise<string[]> => {
  const response = await request(stack.app).get(`/api/services/${serviceId}/availability?from=${date}&to=${date}`).expect(200);
  const parsed = z
    .object({ days: z.array(z.object({ date: z.string(), slots: z.array(z.object({ startsAt: z.string() })) })) })
    .parse(response.body);
  return parsed.days.find((day) => day.date === date)?.slots.map((slot) => slot.startsAt) ?? [];
};

const exceptionCount = async (): Promise<number> => {
  const result = await stack.db.query("app", `SELECT count(*)::int AS n FROM "ScheduleException"`);
  return z.array(z.object({ n: z.number() })).parse(result.rows)[0]?.n ?? -1;
};

beforeAll(async () => {
  stack = await startBookingStack(1);
  users = await createUsers(stack);
});

beforeEach(async () => {
  stack.setNow(NOW);
  await resetCalendar(stack.db);
  serviceId = await insertService(stack.db, { name: "Massage 60", durationMinutes: 60 });
  await request(stack.app).put("/api/admin/schedule/weekly").set(admin()).send({ intervals: WEEK }).expect(200);
});

afterAll(async () => {
  await stack.close();
});

describe("schedule of a week or a month", () => {
  it("a week with different hours on each date: two ranges, one range, closed, the weekly rule", async () => {
    const changed = await putDays([
      { date: "2027-03-02", intervals: [{ start: "09:00", end: "13:00" }, { start: "14:00", end: "20:30" }] },
      { date: "2027-03-03", intervals: [{ start: "12:00", end: "18:00" }] },
      { date: "2027-03-04", closed: true },
      { date: "2027-03-05", intervals: [{ start: "08:00", end: "10:00" }, { start: "11:00", end: "12:00" }, { start: "16:00", end: "21:00" }] },
    ]).expect(200);
    expect(daysOf(changed.body).map((day) => day.date)).toEqual(["2027-03-02", "2027-03-03", "2027-03-04", "2027-03-05"]);

    const days = daysOf((await getDays("2027-03-01", "2027-03-07").expect(200)).body);
    // No closures here: what can be booked is the schedule itself.
    expect(days.every((day) => day.closure === null && day.effective.open === !day.closed)).toBe(true);
    expect(days.map((day) => day.effective.intervals)).toEqual(days.map((day) => day.intervals));
    const week = days.map(({ closure: _closure, effective: _effective, ...schedule }) => schedule);
    expect(week).toEqual([
      { date: "2027-03-01", weekday: 1, closed: false, source: "weekly", intervals: [{ start: "09:00", end: "20:30" }] },
      {
        date: "2027-03-02",
        weekday: 2,
        closed: false,
        source: "exception",
        intervals: [{ start: "09:00", end: "13:00" }, { start: "14:00", end: "20:30" }],
      },
      { date: "2027-03-03", weekday: 3, closed: false, source: "exception", intervals: [{ start: "12:00", end: "18:00" }] },
      { date: "2027-03-04", weekday: 4, closed: true, source: "exception", intervals: [] },
      {
        date: "2027-03-05",
        weekday: 5,
        closed: false,
        source: "exception",
        intervals: [{ start: "08:00", end: "10:00" }, { start: "11:00", end: "12:00" }, { start: "16:00", end: "21:00" }],
      },
      { date: "2027-03-06", weekday: 6, closed: false, source: "weekly", intervals: [{ start: "09:00", end: "20:30" }] },
      { date: "2027-03-07", weekday: 7, closed: false, source: "weekly", intervals: [{ start: "09:00", end: "20:30" }] },
    ]);

    // Clients see exactly these hours.
    const tuesday = await slotsOn("2027-03-02");
    expect(tuesday).toContain(paris("2027-03-02", "12:00"));
    expect(tuesday).not.toContain(paris("2027-03-02", "12:15"));
    expect(tuesday).toContain(paris("2027-03-02", "14:00"));
    const wednesday = await slotsOn("2027-03-03");
    expect([wednesday[0], wednesday.at(-1)]).toEqual([paris("2027-03-03", "12:00"), paris("2027-03-03", "17:00")]);
    expect(await slotsOn("2027-03-04")).toEqual([]);
    expect((await slotsOn("2027-03-05"))[0]).toBe(paris("2027-03-05", "08:00"));
  });

  it("a whole month closed in one request, then opened again with the weekly rule", async () => {
    const march = Array.from({ length: 31 }, (_, index) => dateAfter("2027-03-01", index));
    await putDays(march.map((date) => ({ date, closed: true }))).expect(200);
    const closed = daysOf((await getDays("2027-03-01", "2027-03-31").expect(200)).body);
    expect(closed).toHaveLength(31);
    expect(closed.every((day) => day.closed && day.source === "exception")).toBe(true);
    expect(await slotsOn("2027-03-15")).toEqual([]);
    expect((await getDays("2027-04-01", "2027-04-01").expect(200)).body).toMatchObject({ days: [{ closed: false, source: "weekly" }] });

    await putDays(march.map((date) => ({ date, useWeekly: true }))).expect(200);
    expect(await exceptionCount()).toBe(0);
    expect((await slotsOn("2027-03-15"))[0]).toBe(paris("2027-03-15", "09:00"));
  });

  it("a month of own hours: the same intervals for every date, replacing earlier ones", async () => {
    await putDays([{ date: "2027-03-10", closed: true }]).expect(200);
    const march = Array.from({ length: 31 }, (_, index) => dateAfter("2027-03-01", index));
    const response = await putDays(march.map((date) => ({ date, intervals: [{ start: "10:00", end: "16:00" }] }))).expect(200);
    expect(daysOf(response.body).every((day) => day.intervals.length === 1 && day.intervals[0]?.start === "10:00")).toBe(true);
    expect(await exceptionCount()).toBe(31);
    expect((await slotsOn("2027-03-10"))[0]).toBe(paris("2027-03-10", "10:00"));
  });

  it("all or nothing: one conflicting date refuses the whole change", async () => {
    await request(stack.app)
      .post("/api/bookings")
      .set(bearer(users.clientA))
      .set("Idempotency-Key", "schedule-days-0001")
      .send({ serviceId, startsAt: paris("2027-03-03", "15:00") })
      .expect(201);

    const refused = await putDays([
      { date: "2027-03-02", closed: true },
      { date: "2027-03-03", intervals: [{ start: "09:00", end: "12:00" }] },
    ]).expect(409);
    expect(refused.body).toMatchObject({ code: "SCHEDULE_CONFLICT", conflicts: [{ startsAt: paris("2027-03-03", "15:00") }] });
    expect(await exceptionCount()).toBe(0);
    expect((await slotsOn("2027-03-02")).length).toBeGreaterThan(0);

    // Hours that still hold the booking are accepted.
    await putDays([
      { date: "2027-03-02", closed: true },
      { date: "2027-03-03", intervals: [{ start: "14:00", end: "18:00" }] },
    ]).expect(200);
  });

  it("refuses invalid changes and ranges", async () => {
    const tooMany = Array.from({ length: 63 }, (_, index) => ({ date: dateAfter("2027-03-01", index), closed: true }));
    for (const days of [
      [],
      tooMany,
      [{ date: "2027-03-02", closed: true }, { date: "2027-03-02", useWeekly: true }],
      [{ date: "2027-02-30", closed: true }],
      [{ date: "2027-03-02", closed: false }],
      [{ date: "2027-03-02", intervals: [] }],
      [{ date: "2027-03-02", intervals: [{ start: "10:00", end: "12:00" }, { start: "11:00", end: "13:00" }] }],
      [{ date: "2027-03-02", intervals: [{ start: "14:00", end: "10:00" }] }],
      [{ date: "2027-03-02", closed: true, intervals: [{ start: "10:00", end: "12:00" }] }],
    ]) {
      expect((await putDays(days)).body, JSON.stringify(days).slice(0, 80)).toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(await exceptionCount()).toBe(0);

    for (const [from, to] of [
      ["2027-03-10", "2027-03-01"],
      ["2027-03-01", "2027-05-02"],
      ["2027-03-01", "nope"],
    ]) {
      expect((await getDays(from ?? "", to ?? "")).body).toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect((await request(stack.app).get("/api/admin/schedule/days?from=2027-03-01").set(admin())).status).toBe(400);
    expect(daysOf((await getDays("2027-03-01", "2027-05-01").expect(200)).body)).toHaveLength(62);
  });

  it("administrator only", async () => {
    expect((await getDays("2027-03-01", "2027-03-07", bearer(users.clientA))).status).toBe(403);
    expect((await putDays([{ date: "2027-03-02", closed: true }], bearer(users.clientA))).status).toBe(403);
    expect((await request(stack.app).get("/api/admin/schedule/days?from=2027-03-01&to=2027-03-07")).status).toBe(401);
    expect(await exceptionCount()).toBe(0);
  });
});
