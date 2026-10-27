import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketingMailer } from "../../src/modules/email/service/email.service.js";
import { createActionTokenService } from "../../src/modules/email/tokens/action-token.service.js";
import { createMarketingRepository } from "../../src/modules/marketing/marketing.repository.js";
import { createMarketingService } from "../../src/modules/marketing/marketing.service.js";
import { createDatabase, type Database } from "../../src/shared/database/database.js";
import { createCapturingLogger } from "../helpers/logs.js";
import { runMigrations } from "./helpers/migrations.js";
import {
  CURRENT_INIT_DIR,
  assertDockerAvailable,
  startPostgres,
  type PostgresContainer,
} from "./helpers/postgres-container.js";

// The Prisma repository's conditional updates (claim, single-use nonce,
// idempotent unsubscribe) against PostgreSQL, as the runtime role.

const SECRET = "integration-marketing-secret-0123456789";

let db: PostgresContainer;
let database: Database;
const sent: { email: string; url: string }[] = [];

const mailer: MarketingMailer = {
  sendConfirmationRequest: (email, url) => {
    sent.push({ email, url });
    return Promise.resolve();
  },
  sendSubscriptionConfirmed: (email, url) => {
    sent.push({ email, url });
    return Promise.resolve();
  },
};

const tokenOf = (index: number) => new URL(sent[index]?.url ?? "http://x/").searchParams.get("token") ?? "";

const statusOf = async (email: string): Promise<unknown[]> => {
  const result = await db.query("admin", `SELECT status FROM "MarketingSubscription" WHERE email = '${email}'`);
  const rows: unknown[] = result.rows;
  return rows;
};

beforeAll(async () => {
  assertDockerAvailable();
  db = await startPostgres(CURRENT_INIT_DIR);
  await runMigrations(db);
  database = createDatabase(
    { url: db.url("app"), sslMode: "disable", poolMax: 10, connectTimeoutMs: 5_000, queryTimeoutMs: 10_000 },
    createCapturingLogger().logger,
  );
});

afterAll(async () => {
  await database.close();
  db.stop();
});

describe("marketing subscription in PostgreSQL", () => {
  it("double opt-in, single-use confirmation and idempotent unsubscribe", async () => {
    const service = createMarketingService({
      repository: createMarketingRepository(database.prisma),
      mailer,
      tokens: createActionTokenService(SECRET),
      frontendUrl: "https://front.example.invalid",
      logger: createCapturingLogger().logger,
    });

    // Concurrent requests for one address: one row, one email.
    await Promise.all(Array.from({ length: 10 }, () => service.requestSubscription("pg@example.invalid")));
    expect(sent).toHaveLength(1);
    expect(await statusOf("pg@example.invalid")).toEqual([{ status: "pending" }]);

    const confirmToken = tokenOf(0);
    expect(await service.confirm(confirmToken)).toBe("subscribed");
    expect(await statusOf("pg@example.invalid")).toEqual([{ status: "subscribed" }]);
    expect(await service.confirm(confirmToken)).toBe("already_subscribed");

    await service.unsubscribe(tokenOf(1));
    await service.unsubscribe(tokenOf(1));
    expect(await statusOf("pg@example.invalid")).toEqual([{ status: "unsubscribed" }]);
    await expect(service.confirm(confirmToken)).rejects.toMatchObject({ statusCode: 400 });

    const unknown = createActionTokenService(SECRET).createToken(
      "marketing_unsubscribe",
      "00000000-0000-4000-8000-000000000000",
    );
    await expect(service.unsubscribe(unknown)).resolves.toBeUndefined();
  });

  it("carries over only confirmed legacy consent, keeping legacy ids for old unsubscribe links", async () => {
    // The migration already ran on an empty table; replay its INSERT on
    // legacy rows to check the selection rules.
    await db.query(
      "admin",
      `INSERT INTO "User"(id, email, status, "marketingConsent", "emailVerified", "updatedAt") VALUES
         ('11111111-1111-4111-8111-111111111111', 'Legacy.Confirmed@example.invalid', 'subscribed', true, true, now()),
         ('22222222-2222-4222-8222-222222222222', 'legacy.unconfirmed@example.invalid', 'subscribed', true, false, now()),
         ('legacy-non-uuid', 'legacy.nonuuid@example.invalid', 'registered', true, true, now()),
         ('33333333-3333-4333-8333-333333333333', 'legacy.optout@example.invalid', 'registered', false, true, now())`,
    );
    const migrationSql = (await import("node:fs")).readFileSync(
      new URL("../../prisma/migrations/20261027120000_firebase_profiles_and_marketing/migration.sql", import.meta.url),
      "utf8",
    );
    const carryOver = migrationSql.slice(migrationSql.indexOf('INSERT INTO "MarketingSubscription"'));
    await db.query("migrator", carryOver);

    const rows = await db.query(
      "admin",
      `SELECT id::text, email, status FROM "MarketingSubscription" WHERE email LIKE 'legacy%' ORDER BY email`,
    );
    const carried: unknown[] = rows.rows;
    expect(carried).toHaveLength(2);
    expect(carried[0]).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      email: "legacy.confirmed@example.invalid",
      status: "subscribed",
    });
    expect(carried[1]).toMatchObject({ email: "legacy.nonuuid@example.invalid", status: "subscribed" });
    expect(carried[1]).not.toMatchObject({ id: "legacy-non-uuid" });

    // An unsubscribe link sent before the migration (legacy user id) still works.
    const service = createMarketingService({
      repository: createMarketingRepository(database.prisma),
      mailer,
      tokens: createActionTokenService(SECRET),
      frontendUrl: "https://front.example.invalid",
      logger: createCapturingLogger().logger,
    });
    await service.unsubscribe(
      createActionTokenService(SECRET).createToken("marketing_unsubscribe", "11111111-1111-4111-8111-111111111111"),
    );
    expect(await statusOf("legacy.confirmed@example.invalid")).toEqual([{ status: "unsubscribed" }]);
  });
});
