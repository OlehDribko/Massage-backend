import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CALENDAR_LOCK_KEY } from "../../src/modules/schedule/calendar-transaction.js";
import { runMigrations } from "./helpers/migrations.js";
import { CURRENT_INIT_DIR, assertDockerAvailable, startPostgres, type PostgresContainer } from "./helpers/postgres-container.js";

// The catalogue is maintained with data migrations run by our migration task
// (`prisma migrate deploy`). These tests run the real runner with the
// repository template as an extra migration.

const TEMPLATE = readFileSync(fileURLToPath(new URL("../../prisma/templates/catalog-data-migration.sql", import.meta.url)), "utf8");
const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";

// The advisory lock key as pg_locks shows a bigint key: high and low 32 bits.
const LOCK_CLASSID = Math.floor(CALENDAR_LOCK_KEY / 2 ** 32);
const LOCK_OBJID = CALENDAR_LOCK_KEY % 2 ** 32;

/** Records, per statement, its transaction id and whether this session holds the calendar lock. */
const PROBE_TABLE = `CREATE TABLE "CatalogMigrationProbe" (step int, tx bigint, "calendarLocked" boolean);`;
const probe = (step: number) =>
  `INSERT INTO "CatalogMigrationProbe" SELECT ${String(step)}, txid_current(), EXISTS (
     SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
       AND classid = ${String(LOCK_CLASSID)} AND objid = ${String(LOCK_OBJID)});`;

const probeRows = async (db: PostgresContainer) => {
  const result = await db.query("admin", `SELECT step, tx::text AS tx, "calendarLocked" FROM "CatalogMigrationProbe" ORDER BY step`);
  return z.array(z.object({ step: z.number(), tx: z.string(), calendarLocked: z.boolean() })).parse(result.rows);
};

let db: PostgresContainer | undefined;

const freshDatabase = async (): Promise<PostgresContainer> => {
  assertDockerAvailable();
  db = await startPostgres(CURRENT_INIT_DIR);
  return db;
};

afterEach(() => {
  db?.stop();
  db = undefined;
});

describe("sale price migration (20261102120000_service_sale_price)", () => {
  it("is additive: data of the previous schema stays, writes and reads without the new columns keep working", async () => {
    const database = await freshDatabase();
    await runMigrations(database, "booking_app", "20261031120000_booking_notifications");
    await database.query(
      "migrator",
      `INSERT INTO "Service" (id, name, "durationMinutes", "priceCents", "updatedAt") VALUES ('${SAMPLE_ID}', 'Before', 60, 8500, now())`,
    );

    await runMigrations(database);

    // The previous API version's statements (no sale columns) still work.
    await database.query(
      "migrator",
      `INSERT INTO "Service" (id, name, "durationMinutes", "priceCents", "updatedAt") VALUES ('00000000-0000-4000-8000-000000000002', 'Old style', 30, 5000, now())`,
    );
    const old = await database.query(
      "app",
      `SELECT id, name, "durationMinutes", "priceCents", currency, "archivedAt" FROM "Service" WHERE id IN ('${SAMPLE_ID}', '00000000-0000-4000-8000-000000000002') ORDER BY id`,
    );
    expect(old.rows).toHaveLength(2);
    const sale = await database.query(
      "app",
      `SELECT "salePriceCents", "saleEndsAt" FROM "Service" WHERE id IN ('${SAMPLE_ID}', '00000000-0000-4000-8000-000000000002')`,
    );
    expect(sale.rows).toEqual([
      { salePriceCents: null, saleEndsAt: null },
      { salePriceCents: null, saleEndsAt: null },
    ]);
  });
});

describe("catalogue data migrations", () => {
  it("the template takes the calendar lock and makes all changes in one explicit transaction", async () => {
    const database = await freshDatabase();
    expect(TEMPLATE).toContain(`pg_advisory_xact_lock(${String(CALENDAR_LOCK_KEY)})`);
    const withProbes = TEMPLATE.replace("BEGIN;", `BEGIN;\n${PROBE_TABLE}`)
      .replace(/(SELECT pg_advisory_xact_lock\(\d+\);)/, `$1\n${probe(1)}`)
      .replace(/\nCOMMIT;/, `\n${probe(2)}\nCOMMIT;`);
    await runMigrations(database, "booking_app", undefined, { extra: [{ name: "20991231000000_catalog_template", sql: withProbes }] });

    const rows = await probeRows(database);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.calendarLocked)).toBe(true); // held from the lock to the end
    expect(new Set(rows.map((row) => row.tx)).size).toBe(1); // one transaction

    // The row without description fits the column's constraints; the runtime role can read it.
    const service = await database.query("app", `SELECT name, description, currency, "archivedAt" FROM "Service" WHERE id = '${SAMPLE_ID}'`);
    expect(service.rows).toEqual([{ name: "Sample service", description: null, currency: "EUR", archivedAt: null }]);
  });

  it("why the template needs BEGIN/COMMIT: without them each statement is its own transaction and the lock is gone at once", async () => {
    const database = await freshDatabase();
    const implicit = [PROBE_TABLE, `SELECT pg_advisory_xact_lock(${String(CALENDAR_LOCK_KEY)});`, probe(1), probe(2)].join("\n");
    await runMigrations(database, "booking_app", undefined, { extra: [{ name: "20991231000000_catalog_implicit", sql: implicit }] });
    const rows = await probeRows(database);
    expect(rows.some((row) => row.calendarLocked)).toBe(false);
    expect(new Set(rows.map((row) => row.tx)).size).toBe(2);
  });

  it("an invalid value rolls back the whole catalogue change and the migration task fails", async () => {
    const database = await freshDatabase();
    const broken = TEMPLATE.replace(
      `('${SAMPLE_ID}', 'Sample service', 60, 6500, now())`,
      `('${SAMPLE_ID}', 'Sample service', 60, 6500, now()),\n  ('00000000-0000-4000-8000-000000000001', 'Too long', 600, 6500, now())`,
    );
    expect(broken).not.toBe(TEMPLATE);
    const result = await runMigrations(database, "booking_app", undefined, {
      extra: [{ name: "20991231000000_catalog_broken", sql: broken }],
      allowFailure: true,
    });
    expect(result.code).not.toBe(0);
    const count = await database.query("admin", `SELECT count(*)::int AS n FROM "Service"`);
    expect(count.rows).toEqual([{ n: 0 }]);
  });

  it("re-running the same upsert in a later migration changes terms without duplicates; bookings are untouched by design", async () => {
    const database = await freshDatabase();
    const changed = TEMPLATE.replace("'Sample service', 60, 6500", "'Sample service', 90, 9000");
    await runMigrations(database, "booking_app", undefined, {
      extra: [
        { name: "20991231000000_catalog_first", sql: TEMPLATE },
        { name: "20991231000001_catalog_second", sql: changed },
      ],
    });
    const service = await database.query("app", `SELECT "durationMinutes", "priceCents" FROM "Service"`);
    expect(service.rows).toEqual([{ durationMinutes: 90, priceCents: 9000 }]);
  });
});
