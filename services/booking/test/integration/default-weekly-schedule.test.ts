import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { localDateTimeToInstant } from "../../src/modules/schedule/zoned-time.js";
import { bearer, createUsers, startBookingStack, type BookingStack } from "./helpers/booking-app.js";

// Default weekly schedule (migration 20261104120000_default_weekly_schedule),
// applied by the real migration runner: every date is open, every day
// 09:00–20:30 Europe/Paris, until the admin closes or changes dates.

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../prisma/migrations/20261104120000_default_weekly_schedule/migration.sql", import.meta.url)),
  "utf8",
);

// "Massage Tuina aux huiles chaudes", 60 minutes (initial catalogue).
const SERVICE_ID = "8768f0f0-3e76-4ed6-a273-5dd431a305e5";
const DEFAULT_WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "09:00", end: "20:30" }));

let stack: BookingStack;
let users: Awaited<ReturnType<typeof createUsers>>;

const weeklyRows = async () => {
  const result = await stack.db.query(
    "app",
    `SELECT weekday, "startMinute", "endMinute" FROM "WeeklyScheduleInterval" ORDER BY weekday, "startMinute"`,
  );
  return z.array(z.object({ weekday: z.number(), startMinute: z.number(), endMinute: z.number() })).parse(result.rows);
};

const paris = (date: string, hhmm: string): string => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return localDateTimeToInstant(date, Number(h) * 60 + Number(m), "Europe/Paris").toISOString();
};

const slotsOn = async (date: string): Promise<string[]> => {
  const response = await request(stack.app).get(`/api/services/${SERVICE_ID}/availability?from=${date}&to=${date}`).expect(200);
  const parsed = z
    .object({ days: z.array(z.object({ date: z.string(), slots: z.array(z.object({ startsAt: z.string() })) })) })
    .parse(response.body);
  return parsed.days.find((day) => day.date === date)?.slots.map((slot) => slot.startsAt) ?? [];
};

beforeAll(async () => {
  // Server clock: Monday 2027-03-01 07:00 in Paris.
  stack = await startBookingStack(1);
  users = await createUsers(stack);
});

afterAll(async () => {
  await stack.close();
});

describe("default weekly schedule", () => {
  it("after the migrations every weekday is open 09:00–20:30, with no exceptions", async () => {
    expect(await weeklyRows()).toEqual([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1230 })));

    const schedule = await request(stack.app).get("/api/admin/schedule").set(bearer(users.admin)).expect(200);
    expect(schedule.body).toEqual({ timeZone: "Europe/Paris", weekly: DEFAULT_WEEK, exceptions: [] });
  });

  it("any date is bookable without admin setup: starts every 15 minutes from 09:00 to 19:00, weekends included", async () => {
    const tuesday = await slotsOn("2027-03-02");
    expect(tuesday).toHaveLength(41);
    expect(tuesday[0]).toBe(paris("2027-03-02", "09:00"));
    expect(tuesday.at(-1)).toBe(paris("2027-03-02", "19:00"));
    expect(await slotsOn("2027-03-07")).toEqual(tuesday.map((startsAt) => new Date(Date.parse(startsAt) + 5 * 86_400_000).toISOString()));
    // Today: only starts at least 12 hours from now (07:00 + 12 h = 19:00).
    expect(await slotsOn("2027-03-01")).toEqual([paris("2027-03-01", "19:00")]);
  });

  it("the admin closes a date and opens it again; other dates stay open", async () => {
    const open = await slotsOn("2027-03-07");
    await request(stack.app).put("/api/admin/schedule/exceptions/2027-03-07").set(bearer(users.admin)).send({ closed: true }).expect(200);
    expect(await slotsOn("2027-03-07")).toEqual([]);
    expect(await slotsOn("2027-03-06")).toHaveLength(41);

    await request(stack.app).delete("/api/admin/schedule/exceptions/2027-03-07").set(bearer(users.admin)).expect(200);
    expect(await slotsOn("2027-03-07")).toEqual(open);
  });

  it("the migration only inserts weekly intervals into an empty schedule, in one explicit transaction under the calendar lock", () => {
    expect(MIGRATION).toMatch(/^BEGIN;$/m);
    expect(MIGRATION).toMatch(/^SELECT pg_advisory_xact_lock\(7316442001\);$/m);
    expect(MIGRATION).toMatch(/^COMMIT;$/m);
    const statements = MIGRATION.replace(/^\s*--.*$/gm, "");
    expect(statements).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM "WeeklyScheduleInterval"\)/);
    expect(statements).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i);
    expect(statements).not.toMatch(/"Booking"|"ScheduleException"|"Service"/);
  });

  it("running it again neither duplicates the default nor overwrites a schedule the admin has set", async () => {
    await stack.db.query("migrator", MIGRATION);
    expect(await weeklyRows()).toHaveLength(7);

    const own = [{ weekday: 2, start: "10:00", end: "14:00" }];
    await request(stack.app).put("/api/admin/schedule/weekly").set(bearer(users.admin)).send({ intervals: own }).expect(200);
    await stack.db.query("migrator", MIGRATION);
    expect(await weeklyRows()).toEqual([{ weekday: 2, startMinute: 600, endMinute: 840 }]);

    await request(stack.app).put("/api/admin/schedule/weekly").set(bearer(users.admin)).send({ intervals: DEFAULT_WEEK }).expect(200);
  });
});
