import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { VerifiedIdentity } from "../../src/modules/auth/identity.js";
import { createProfileRepository, type ProfileRepository } from "../../src/modules/profiles/profile.repository.js";
import { createDatabase, type Database } from "../../src/shared/database/database.js";
import { createCapturingLogger } from "../helpers/logs.js";
import { runMigrations } from "./helpers/migrations.js";
import { CURRENT_INIT_DIR, assertDockerAvailable, startPostgres, type PostgresContainer } from "./helpers/postgres-container.js";

// Profile sync against real PostgreSQL as the runtime role: it writes only
// when the token changes something, and an older token never rolls the
// profile back, also under concurrent requests. (Token verification itself,
// including the revocation check on every request, is unchanged and covered
// by the Auth Emulator tests in auth-profiles.test.ts.)

let db: PostgresContainer;
let database: Database;
let repository: ProfileRepository;

const T0 = new Date("2027-03-01T08:00:00Z");
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const identity = (overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  uid: "uid-sync",
  isAnonymous: false,
  signInProvider: "password",
  email: "anna@example.invalid",
  emailVerified: false,
  name: undefined,
  issuedAt: T0,
  ...overrides,
});

const rowSchema = z.object({ version: z.string(), updatedAt: z.date(), emailVerified: z.boolean(), email: z.string().nullable(), issuedAt: z.date() });

/** xmin changes with every write of the row, even one that changes no value. */
const row = async () => {
  const result = await db.query(
    "admin",
    // The columns are timestamp without time zone holding UTC (Prisma's
    // convention); read them as UTC, not in the machine's zone.
    `SELECT xmin::text AS version, "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt", "emailVerified", email,
            "identityIssuedAt" AT TIME ZONE 'UTC' AS "issuedAt"
       FROM "UserProfile" WHERE "firebaseUid" = 'uid-sync'`,
  );
  return rowSchema.parse(result.rows[0]);
};

const count = async () => {
  const result = await db.query("admin", `SELECT count(*)::int AS n FROM "UserProfile" WHERE "firebaseUid" = 'uid-sync'`);
  return z.object({ n: z.number() }).parse(result.rows[0]).n;
};

beforeAll(async () => {
  assertDockerAvailable();
  db = await startPostgres(CURRENT_INIT_DIR);
  await runMigrations(db);
  database = createDatabase(
    { url: db.url("app"), sslMode: "disable", poolMax: 10, connectTimeoutMs: 5_000, queryTimeoutMs: 10_000 },
    createCapturingLogger().logger,
  );
  repository = createProfileRepository(database.prisma);
});

afterAll(async () => {
  await database.close();
  db.stop();
});

beforeEach(async () => {
  await db.query("admin", `DELETE FROM "UserProfile" WHERE "firebaseUid" = 'uid-sync'`);
});

describe("profile sync writes", () => {
  it("repeated requests with the same token do not write the profile at all", async () => {
    await repository.syncIdentity(identity(), "Anna");
    const first = await row();
    for (let i = 0; i < 5; i += 1) {
      const profile = await repository.syncIdentity(identity(), "Anna");
      expect(profile.email).toBe("anna@example.invalid");
    }
    const after = await row();
    expect(after.version).toBe(first.version);
    expect(after.updatedAt).toEqual(first.updatedAt);
  });

  it("a newer token updates the identity fields", async () => {
    await repository.syncIdentity(identity(), "Anna");
    const before = await row();
    const profile = await repository.syncIdentity(identity({ emailVerified: true, issuedAt: later(60) }), "Anna");
    expect(profile.emailVerified).toBe(true);
    const after = await row();
    expect(after.version).not.toBe(before.version);
    expect(after).toMatchObject({ emailVerified: true, issuedAt: later(60) });
  });

  it("an older token never rolls the profile back, and does not write", async () => {
    await repository.syncIdentity(identity({ emailVerified: true, issuedAt: later(60) }), "Anna");
    const before = await row();
    const profile = await repository.syncIdentity(identity({ emailVerified: false, issuedAt: T0 }), "Anna");
    expect(profile.emailVerified).toBe(true);
    expect((await row()).version).toBe(before.version);
  });

  it("the same token time with different claims is applied", async () => {
    await repository.syncIdentity(identity(), "Anna");
    await repository.syncIdentity(identity({ emailVerified: true }), "Anna");
    expect(await row()).toMatchObject({ emailVerified: true, issuedAt: T0 });
  });

  it("concurrent first requests create one profile; the newest token wins", async () => {
    await Promise.all(
      [0, 30, 10, 60, 20].map((minutes) =>
        repository.syncIdentity(identity({ emailVerified: minutes === 60, issuedAt: later(minutes) }), "Anna"),
      ),
    );
    expect(await count()).toBe(1);
    expect(await row()).toMatchObject({ emailVerified: true, issuedAt: later(60) });
  });

  it("an older and a newer token racing on an existing profile: the newer one stays (atomic guard)", async () => {
    await repository.syncIdentity(identity(), "Anna");
    for (let round = 1; round <= 5; round += 1) {
      await Promise.all([
        repository.syncIdentity(identity({ email: `old-${String(round)}@example.invalid`, issuedAt: later(round * 10 - 5) }), "Anna"),
        repository.syncIdentity(identity({ email: `new-${String(round)}@example.invalid`, issuedAt: later(round * 10) }), "Anna"),
      ]);
      expect(await row()).toMatchObject({ email: `new-${String(round)}@example.invalid`, issuedAt: later(round * 10) });
    }
  });
});
