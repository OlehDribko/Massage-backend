import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startBookingStack, type BookingStack } from "./helpers/booking-app.js";

// Client-facing texts of the initial catalogue (migration
// 20261103120100_catalog_service_texts), applied by the real migration runner
// like every other migration, checked against the agreed texts (test/fixtures)
// and served by the public catalogue API.

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const MIGRATION = read("../../prisma/migrations/20261103120100_catalog_service_texts/migration.sql");
const INITIAL_CATALOGUE = read("../../prisma/migrations/20261101120000_catalog_initial_services/migration.sql");

const parseJson = (text: string): unknown => {
  const value: unknown = JSON.parse(text);
  return value;
};
const TEXTS = z
  .array(
    z.object({
      n: z.int(),
      id: z.uuid(),
      name: z.string(),
      durationMinutes: z.int(),
      description: z.string(),
      features: z.array(z.string()),
    }),
  )
  .parse(parseJson(read("../fixtures/catalog-service-texts.json")));
const CATALOGUE = z
  .array(z.object({ id: z.uuid(), name: z.string(), durationMinutes: z.int() }))
  .parse(parseJson(read("../fixtures/catalog-initial-services.json")));

const rowSchema = z.object({ id: z.string(), description: z.string().nullable(), features: z.array(z.string()) });

let stack: BookingStack;

const texts = async () => {
  const result = await stack.db.query("app", `SELECT id, description, features FROM "Service" ORDER BY id`);
  return z.array(rowSchema).parse(result.rows);
};
const expectedRows = () =>
  TEXTS.map((service) => ({ id: service.id, description: service.description, features: service.features })).sort((a, b) =>
    a.id.localeCompare(b.id),
  );

beforeAll(async () => {
  stack = await startBookingStack(1);
});

afterAll(async () => {
  await stack.close();
});

describe("catalogue texts", () => {
  it("the agreed texts: one per service of the initial catalogue, same names and durations, within the limits", () => {
    expect(TEXTS).toHaveLength(35);
    expect(TEXTS.map((service) => service.n)).toEqual(Array.from({ length: 35 }, (_, index) => index + 1));
    expect(TEXTS.map((service) => service.id).sort()).toEqual(CATALOGUE.map((service) => service.id).sort());
    for (const service of TEXTS) {
      const catalogued = CATALOGUE.find((entry) => entry.id === service.id);
      expect({ name: service.name, durationMinutes: service.durationMinutes }, service.id).toEqual({
        name: catalogued?.name,
        durationMinutes: catalogued?.durationMinutes,
      });
      expect(service.description.length, service.id).toBeGreaterThan(0);
      expect(service.description.length, service.id).toBeLessThanOrEqual(2000);
      expect(service.features.length, service.id).toBeGreaterThan(0);
      expect(service.features.length, service.id).toBeLessThanOrEqual(10);
      for (const text of [service.description, ...service.features]) {
        expect(text, service.id).toBe(text.trim());
        expect(text.length, service.id).toBeGreaterThan(0);
        // Editorial notes are not published.
        expect(text, service.id).not.toMatch(/avant publication|Référence NHS|à confirmer|intitulé fourni|Abhyanga/i);
      }
    }
  });

  it("after the migrations every service of the catalogue has its description and features", async () => {
    expect(await texts()).toEqual(expectedRows());
  });

  it("the public catalogue serves the texts with the services", async () => {
    const list = await request(stack.app).get("/api/services").expect(200);
    const listed = z.object({ services: z.array(z.object({ id: z.string(), description: z.string().nullable(), features: z.array(z.string()) })) }).parse(list.body).services;
    expect(listed.sort((a, b) => a.id.localeCompare(b.id))).toEqual(expectedRows());

    const reflexology = TEXTS.find((service) => service.name === "Réflexologie plantaire");
    const one = await request(stack.app).get(`/api/services/${reflexology?.id ?? ""}`).expect(200);
    expect(one.body).toMatchObject({ service: { description: reflexology?.description, features: reflexology?.features } });
  });

  it("the migration only sets texts of these ids, in one explicit transaction under the calendar lock", () => {
    expect(MIGRATION).toMatch(/^BEGIN;$/m);
    expect(MIGRATION).toMatch(/^SELECT pg_advisory_xact_lock\(7316442001\);$/m);
    expect(MIGRATION).toMatch(/^COMMIT;$/m);
    const statements = MIGRATION.replace(/^\s*--.*$/gm, "");
    expect(statements).toMatch(/SET "description" = v\.description, "features" = v\.features, "updatedAt" = now\(\)/);
    expect(statements).not.toMatch(/\b(INSERT|DELETE|TRUNCATE|DROP|ALTER)\b/i);
    expect(statements).not.toMatch(/"Booking"|"archivedAt"|"priceCents"|"salePriceCents"|"durationMinutes"|"name"/);
    for (const service of TEXTS) {
      expect(statements).toContain(`'${service.id}'::uuid`);
    }
  });

  it("running it again restores the agreed texts and leaves other services alone", async () => {
    const first = TEXTS[0];
    if (first === undefined) {
      throw new Error("no texts");
    }
    await stack.db.query(
      "migrator",
      `INSERT INTO "Service" (id, name, "durationMinutes", "priceCents", "updatedAt") VALUES
         ('00000000-0000-4000-8000-0000000000b1', 'Other service', 30, 1000, now())`,
    );
    await stack.db.query("migrator", `UPDATE "Service" SET description = 'Changed by hand', features = ARRAY['x'] WHERE id = '${first.id}'`);

    await stack.db.query("migrator", MIGRATION);
    await stack.db.query("migrator", MIGRATION);

    const all = await texts();
    expect(all.find((row) => row.id === "00000000-0000-4000-8000-0000000000b1")).toEqual({
      id: "00000000-0000-4000-8000-0000000000b1",
      description: null,
      features: [],
    });
    expect(all.filter((row) => row.id !== "00000000-0000-4000-8000-0000000000b1")).toEqual(expectedRows());
    await stack.db.query("migrator", `DELETE FROM "Service" WHERE id = '00000000-0000-4000-8000-0000000000b1'`);
  });

  it("a missing service makes the migration fail without changing any text", async () => {
    const [first, second] = TEXTS;
    if (first === undefined || second === undefined) {
      throw new Error("no texts");
    }
    await stack.db.query("migrator", `UPDATE "Service" SET description = 'Kept', features = '{}' WHERE id = '${second.id}'`);
    await stack.db.query("migrator", `DELETE FROM "Service" WHERE id = '${first.id}'`);

    await expect(stack.db.query("migrator", MIGRATION)).rejects.toThrow(/expected 35 services, updated 34/);
    expect((await texts()).find((row) => row.id === second.id)).toEqual({ id: second.id, description: "Kept", features: [] });

    // Restore: the initial catalogue brings the row back, the texts migration fills it again.
    await stack.db.query("migrator", INITIAL_CATALOGUE);
    await stack.db.query("migrator", MIGRATION);
    expect(await texts()).toEqual(expectedRows());
  });

  it("the database refuses empty, missing or too many features", async () => {
    const id = TEXTS[0]?.id ?? "";
    for (const features of ["ARRAY['']", "ARRAY[NULL]::text[]", `ARRAY[${Array.from({ length: 11 }, () => "'x'").join(", ")}]`, "NULL"]) {
      await expect(stack.db.query("migrator", `UPDATE "Service" SET features = ${features} WHERE id = '${id}'`), features).rejects.toThrow();
    }
    expect(await texts()).toEqual(expectedRows());
  });
});
