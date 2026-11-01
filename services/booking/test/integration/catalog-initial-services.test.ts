import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { localDateTimeToInstant } from "../../src/modules/schedule/zoned-time.js";
import { bearer, createUsers, startBookingStack, type BookingStack } from "./helpers/booking-app.js";

// The initial catalogue (migration 20261101120000_catalog_initial_services),
// applied by the real migration runner like every other migration, checked
// against the owner's list (test/fixtures, prices in euros as agreed).

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../prisma/migrations/20261101120000_catalog_initial_services/migration.sql", import.meta.url)),
  "utf8",
);

const fixtureSchema = z.array(
  z.object({ n: z.int(), id: z.uuid(), name: z.string(), durationMinutes: z.int(), priceEuros: z.int() }),
);
const EXPECTED = fixtureSchema.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/catalog-initial-services.json", import.meta.url)), "utf8")),
);

const rowSchema = z.object({
  id: z.string(),
  name: z.string(),
  durationMinutes: z.number(),
  priceCents: z.number(),
  currency: z.string(),
  description: z.string().nullable(),
  bookable: z.boolean(),
});

let stack: BookingStack;

const services = async () => {
  const result = await stack.db.query(
    "app",
    `SELECT id, name, "durationMinutes", "priceCents", currency, description, "archivedAt" IS NULL AS bookable FROM "Service" ORDER BY id`,
  );
  return z.array(rowSchema).parse(result.rows);
};

const expectedRows = () =>
  EXPECTED.map((service) => ({
    id: service.id,
    name: service.name,
    durationMinutes: service.durationMinutes,
    priceCents: service.priceEuros * 100,
    currency: "EUR",
    description: null,
    bookable: true,
  })).sort((a, b) => a.id.localeCompare(b.id));

beforeAll(async () => {
  stack = await startBookingStack(1);
});

afterAll(async () => {
  await stack.close();
});

describe("initial catalogue", () => {
  it("the owner's list: 35 services, 35 distinct fixed ids", () => {
    expect(EXPECTED).toHaveLength(35);
    expect(EXPECTED.map((service) => service.n)).toEqual(Array.from({ length: 35 }, (_, index) => index + 1));
    expect(new Set(EXPECTED.map((service) => service.id)).size).toBe(35);
    // Spot checks against the agreed table (euros → integer cents happens in the test).
    expect(EXPECTED.find((service) => service.n === 7)).toMatchObject({ name: "Massage premium pour femmes", durationMinutes: 60, priceEuros: 75 });
    expect(EXPECTED.find((service) => service.n === 16)).toMatchObject({ name: "Massage sportif", durationMinutes: 55, priceEuros: 100 });
    expect(EXPECTED.find((service) => service.n === 33)).toMatchObject({ name: "Massage myofascial", durationMinutes: 85, priceEuros: 135 });
    expect(EXPECTED.find((service) => service.n === 23)).toMatchObject({ name: "Endosphères — demi-corps, une séance", durationMinutes: 45, priceEuros: 110 });
  });

  it("after the migrations the database holds exactly these services: exact cents, durations, ids, bookable, no description", async () => {
    expect(await services()).toEqual(expectedRows());
  });

  it("the migration writes only these ids in one explicit transaction under the calendar lock; nothing else", () => {
    expect(MIGRATION).toMatch(/^BEGIN;$/m);
    expect(MIGRATION).toMatch(/^SELECT pg_advisory_xact_lock\(7316442001\);$/m);
    expect(MIGRATION).toMatch(/^COMMIT;$/m);
    expect(MIGRATION).toMatch(/ON CONFLICT \("id"\) DO UPDATE/);
    const statements = MIGRATION.replace(/^--.*$/gm, "");
    expect(statements).not.toMatch(/\b(DELETE|TRUNCATE|DROP|ALTER)\b/i);
    expect(statements).not.toMatch(/"Booking"|"archivedAt"|gen_random_uuid/);
    for (const service of EXPECTED) {
      expect(statements).toContain(`'${service.id}'`);
    }
  });

  it("running it again changes nothing and adds no duplicates; other services are left alone", async () => {
    await stack.db.query(
      "migrator",
      `INSERT INTO "Service" (id, name, "durationMinutes", "priceCents", "archivedAt", "updatedAt") VALUES
         ('00000000-0000-4000-8000-0000000000a1', 'Other bookable', 30, 1000, NULL, now()),
         ('00000000-0000-4000-8000-0000000000a2', 'Other archived', 30, 1000, now(), now())`,
    );
    // A seeded row changed by hand in between: the re-run restores the agreed terms.
    await stack.db.query("migrator", `UPDATE "Service" SET "priceCents" = 1 WHERE id = '${EXPECTED[0]?.id ?? ""}'`);

    await stack.db.query("migrator", MIGRATION);
    await stack.db.query("migrator", MIGRATION);

    const all = await services();
    expect(all).toHaveLength(37);
    expect(all.filter((service) => service.id.startsWith("00000000-0000-4000-8000-0000000000a"))).toEqual([
      { id: "00000000-0000-4000-8000-0000000000a1", name: "Other bookable", durationMinutes: 30, priceCents: 1000, currency: "EUR", description: null, bookable: true },
      { id: "00000000-0000-4000-8000-0000000000a2", name: "Other archived", durationMinutes: 30, priceCents: 1000, currency: "EUR", description: null, bookable: false },
    ]);
    expect(all.filter((service) => !service.id.startsWith("00000000-"))).toEqual(expectedRows());
    await stack.db.query(
      "migrator",
      `DELETE FROM "Service" WHERE id IN ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2')`,
    );
  });

  it("the public catalogue lists all 35; a 55-minute service is booked with the server's duration and price", async () => {
    const list = await request(stack.app).get("/api/services").expect(200);
    const listed = z.object({ services: z.array(z.object({ id: z.string() })) }).parse(list.body).services;
    expect(listed.map((service) => service.id).sort()).toEqual(EXPECTED.map((service) => service.id).sort());

    const users = await createUsers(stack);
    await request(stack.app)
      .put("/api/admin/schedule/weekly")
      .set(bearer(users.admin))
      .send({ intervals: [{ weekday: 2, start: "09:00", end: "21:00" }] })
      .expect(200);
    const sportif55 = EXPECTED.find((service) => service.n === 16);
    const startsAt = localDateTimeToInstant("2027-03-02", 9 * 60, "Europe/Paris");
    const booked = await request(stack.app)
      .post("/api/bookings")
      .set(bearer(users.clientA))
      .set("Idempotency-Key", "catalog-initial-0001")
      .send({ serviceId: sportif55?.id, startsAt: startsAt.toISOString() })
      .expect(201);
    expect(booked.body).toMatchObject({
      booking: {
        service: { id: sportif55?.id, name: "Massage sportif", durationMinutes: 55, priceCents: 10000, currency: "EUR" },
        endsAt: new Date(startsAt.getTime() + 55 * 60_000).toISOString(),
      },
    });
  });
});
