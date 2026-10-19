import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { killRunningChildren, startTsProcess } from "../helpers/child-process.js";
import {
  CURRENT_INIT_DIR,
  LEGACY_INIT_DIR,
  assertDockerAvailable,
  outcome,
  startPostgres,
  type PostgresContainer,
} from "./helpers/postgres-container.js";

// Every connection below goes through the published TCP port with password
// authentication (pg_hba "host all all all scram-sha-256"), not through the
// container-local "trust" entries.

const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PASSWORD = "28P01";

const runRunner = async (
  container: PostgresContainer,
  runtimeRole: string,
  args: string[] = [],
) => {
  const child = startTsProcess(
    "src/migrate/run-migrations.ts",
    {
      MIGRATION_DATABASE_URL: container.url("migrator"),
      MIGRATION_DATABASE_SSL_MODE: "disable",
      BOOKING_RUNTIME_ROLE: runtimeRole,
    },
    args,
  );
  const exit = await child.exited;
  return { code: exit.code, output: child.output(), messages: child.entries().map((e) => e.msg) };
};

const tableExists = async (container: PostgresContainer, table: string) => {
  const result = await container.query("admin", `SELECT to_regclass('public."${table}"') AS rel`);
  const row: unknown = result.rows[0];
  return typeof row === "object" && row !== null && "rel" in row && row.rel !== null;
};

const appDefaultAcls = async (container: PostgresContainer) => {
  const result = await container.query(
    "admin",
    "SELECT count(*)::int AS n FROM pg_default_acl, aclexplode(defaclacl) a WHERE a.grantee = 'booking_app'::regrole",
  );
  const row: unknown = result.rows[0];
  return typeof row === "object" && row !== null && "n" in row ? row.n : undefined;
};

beforeAll(() => {
  assertDockerAvailable();
});

afterEach(async () => {
  await killRunningChildren();
});

describe("fresh database (current init script)", () => {
  let db: PostgresContainer;

  beforeAll(async () => {
    db = await startPostgres(CURRENT_INIT_DIR);
  });

  afterAll(() => {
    db.stop();
  });

  it("authenticates with passwords over TCP and rejects a wrong password", async () => {
    expect(await outcome(db, "app", "SELECT 1")).toBe("ok");
    await expect(db.connect("app", "wrong-password")).rejects.toMatchObject({
      code: INVALID_PASSWORD,
    });
  });

  it("fails before touching the schema when the runtime role does not exist", async () => {
    const result = await runRunner(db, "booking_app_typo");

    expect(result.code).toBe(1);
    expect(result.messages).toContain("privilege preparation failed; migrations not started");
    expect(result.output).toContain('"code":"42704"');
    expect(await tableExists(db, "_prisma_migrations")).toBe(false);
  });

  it("rejects a role name that is not a plain identifier without running SQL", async () => {
    const result = await runRunner(db, 'booking_app"; DROP TABLE x; --');

    expect(result.code).toBe(1);
    expect(result.messages).toContain("invalid migration configuration");
    expect(await tableExists(db, "_prisma_migrations")).toBe(false);
  });

  it("first run applies migrations, grants business DML and keeps _prisma_migrations closed", async () => {
    const result = await runRunner(db, "booking_app");

    expect(result.code).toBe(0);
    expect(result.output).toContain("All migrations have been successfully applied.");
    expect(result.messages).toContain("runtime privileges granted on business tables");

    expect(
      await outcome(
        db,
        "app",
        `INSERT INTO "User"(id, email, status, "updatedAt") VALUES ('it-1', 'it@example.invalid', 'subscribed', now())`,
      ),
    ).toBe("ok");
    expect(await outcome(db, "app", `UPDATE "User" SET name = 'IT' WHERE id = 'it-1'`)).toBe("ok");
    expect(await outcome(db, "app", `SELECT * FROM "User"`)).toBe("ok");

    expect(await outcome(db, "app", "SELECT * FROM _prisma_migrations")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await outcome(db, "app", "DELETE FROM _prisma_migrations")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await outcome(db, "app", "CREATE TABLE intruder(id int)")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await outcome(db, "app", `TRUNCATE "User"`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await appDefaultAcls(db)).toBe(0);
  });

  it("second run is a no-op and keeps the same privileges and data", async () => {
    const result = await runRunner(db, "booking_app");

    expect(result.code).toBe(0);
    expect(result.output).toContain("No pending migrations to apply.");
    expect(await outcome(db, "app", `SELECT * FROM "User" WHERE id = 'it-1'`)).toBe("ok");
    expect(await outcome(db, "app", "SELECT * FROM _prisma_migrations")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await outcome(db, "migrator", "SELECT * FROM _prisma_migrations")).toBe("ok");
  });
});

describe("migration failing after the history table was created", () => {
  let db: PostgresContainer;

  beforeAll(async () => {
    db = await startPostgres(CURRENT_INIT_DIR);
  });

  afterAll(() => {
    db.stop();
  });

  it("returns Prisma's failure and leaves new tables and history closed to the runtime role", async () => {
    const result = await runRunner(db, "booking_app", [
      "--config",
      "test/fixtures/failing-migrations/prisma.config.ts",
    ]);

    expect(result.code).not.toBe(0);
    expect(result.messages).toContain("prisma migrate deploy failed; runtime grants not applied");
    expect(result.messages).not.toContain("runtime privileges granted on business tables");

    // The first migration and the history table exist...
    expect(await tableExists(db, "_prisma_migrations")).toBe(true);
    expect(await tableExists(db, "Widget")).toBe(true);
    // ...but the runtime role has no access to either (no post-failure step needed).
    expect(await outcome(db, "app", "SELECT * FROM _prisma_migrations")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await outcome(db, "app", `SELECT * FROM "Widget"`)).toBe(INSUFFICIENT_PRIVILEGE);
    // The migrator still sees the failed migration.
    const failed = await db.query(
      "migrator",
      "SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL",
    );
    expect(failed.rows).toEqual([{ n: 1 }]);
  });
});

describe("transition from the previous (default-privileges) setup", () => {
  let db: PostgresContainer;

  beforeAll(async () => {
    db = await startPostgres(LEGACY_INIT_DIR);
  });

  afterAll(() => {
    db.stop();
  });

  it("removes runtime access to _prisma_migrations and stale defaults without losing data", async () => {
    // Old chain: plain `prisma migrate deploy` with the old default privileges.
    const legacy = startTsProcess(
      "../../node_modules/prisma/build/index.js",
      { MIGRATION_DATABASE_URL: db.url("migrator"), CHECKPOINT_DISABLE: "1" },
      ["migrate", "deploy"],
    );
    expect((await legacy.exited).code).toBe(0);
    expect(await outcome(db, "app", "SELECT * FROM _prisma_migrations")).toBe("ok");
    expect(await appDefaultAcls(db)).toBeGreaterThan(0);
    expect(
      await outcome(
        db,
        "app",
        `INSERT INTO "User"(id, email, status, "updatedAt") VALUES ('legacy-1', 'legacy@example.invalid', 'registered', now())`,
      ),
    ).toBe("ok");

    const result = await runRunner(db, "booking_app");

    expect(result.code).toBe(0);
    expect(await outcome(db, "app", "SELECT * FROM _prisma_migrations")).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await appDefaultAcls(db)).toBe(0);
    const rows = await db.query("app", `SELECT id FROM "User" WHERE id = 'legacy-1'`);
    expect(rows.rows).toEqual([{ id: "legacy-1" }]);
    expect(await outcome(db, "app", `UPDATE "User" SET name = 'kept' WHERE id = 'legacy-1'`)).toBe("ok");
  });
});
