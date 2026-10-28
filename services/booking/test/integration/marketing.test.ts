import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketingMailer } from "../../src/modules/email/service/email.service.js";
import { createActionTokenService } from "../../src/modules/email/tokens/action-token.service.js";
import { MARKETING_CONSENT_TEXT_VERSION, type ConsentRequest } from "../../src/modules/marketing/consent.js";
import { createMarketingRepository } from "../../src/modules/marketing/marketing.repository.js";
import { createMarketingService } from "../../src/modules/marketing/marketing.service.js";
import { createDatabase, type Database } from "../../src/shared/database/database.js";
import { createCapturingLogger } from "../helpers/logs.js";
import { runMigrations } from "./helpers/migrations.js";
import {
  CURRENT_INIT_DIR,
  assertDockerAvailable,
  outcome,
  startPostgres,
  type PostgresContainer,
} from "./helpers/postgres-container.js";

// The Prisma repository's conditional updates (claims per mode, single-use
// nonce, consent evidence, idempotent unsubscribe) against PostgreSQL, as the
// runtime role, plus the database constraints.

const SECRET = "integration-marketing-secret-0123456789";
const FORM: ConsentRequest = { source: "subscription_form", textVersion: MARKETING_CONSENT_TEXT_VERSION };

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

const rowOf = async (email: string): Promise<unknown> => {
  const result = await db.query(
    "admin",
    `SELECT subscribed, "consentSource"::text AS source, "consentTextVersion" AS version,
            "consentGivenAt" IS NOT NULL AS "hasConsentDate", "unsubscribedAt" IS NOT NULL AS "hasUnsubscribedDate",
            "confirmationNonce" IS NOT NULL AS pending
       FROM "MarketingSubscription" WHERE email = '${email}'`,
  );
  const row: unknown = result.rows[0];
  return row;
};

const service = () =>
  createMarketingService({
    repository: createMarketingRepository(database.prisma),
    mailer,
    tokens: createActionTokenService(SECRET),
    frontendUrl: "https://front.example.invalid",
    logger: createCapturingLogger().logger,
  });

beforeAll(async () => {
  assertDockerAvailable();
  db = await startPostgres(CURRENT_INIT_DIR);
  // Legacy rows that existed before the Firebase migration.
  await runMigrations(db, "booking_app", "20260907191500_add_email_verification_sent_at");
  await db.query(
    "admin",
    `INSERT INTO "User"(id, email, status, "marketingConsent", "emailVerified", "updatedAt") VALUES
       ('11111111-1111-4111-8111-111111111111', 'legacy.verified@example.invalid', 'subscribed', true, true, now()),
       ('22222222-2222-4222-8222-222222222222', 'legacy.unverified@example.invalid', 'subscribed', true, false, now()),
       ('33333333-3333-4333-8333-333333333333', 'legacy.registered@example.invalid', 'registered', false, true, now())`,
  );
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
  it("carries over no legacy consent: emailVerified/marketingConsent are not proof of opt-in", async () => {
    const rows = await db.query("admin", `SELECT count(*)::int AS n FROM "MarketingSubscription"`);
    expect(rows.rows).toEqual([{ n: 0 }]);
    const legacy = await db.query("admin", `SELECT count(*)::int AS n FROM "User"`);
    expect(legacy.rows).toEqual([{ n: 3 }]);

    // An old legacy unsubscribe link answers neutrally and changes nothing.
    await expect(
      service().unsubscribeByToken(
        createActionTokenService(SECRET).createToken("marketing_unsubscribe", "11111111-1111-4111-8111-111111111111"),
      ),
    ).resolves.toBeUndefined();
  });

  it("double opt-in with consent evidence, single-use link, unsubscribe date and explicit re-subscription", async () => {
    const marketing = service();

    // Concurrent requests for one address: one row, one email.
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => marketing.requestSubscription("pg@example.invalid", FORM, "explicit")),
    );
    expect(outcomes.filter((value) => value === "confirmation_sent")).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(await rowOf("pg@example.invalid")).toEqual({
      subscribed: false, source: null, version: null, hasConsentDate: false, hasUnsubscribedDate: false, pending: true,
    });

    const confirmToken = tokenOf(0);
    expect(await marketing.confirm(confirmToken)).toBe("subscribed");
    expect(await rowOf("pg@example.invalid")).toEqual({
      subscribed: true, source: "subscription_form", version: MARKETING_CONSENT_TEXT_VERSION,
      hasConsentDate: true, hasUnsubscribedDate: false, pending: false,
    });
    expect(await marketing.confirm(confirmToken)).toBe("already_subscribed");

    await marketing.unsubscribeByToken(tokenOf(1));
    await marketing.unsubscribeByToken(tokenOf(1));
    expect(await rowOf("pg@example.invalid")).toMatchObject({ subscribed: false, hasUnsubscribedDate: true });
    await expect(marketing.confirm(confirmToken)).rejects.toMatchObject({ statusCode: 400 });

    // The sign-up checkbox never re-subscribes after an unsubscribe…
    expect(
      await marketing.requestSubscription("pg@example.invalid", { source: "signup_checkbox", textVersion: MARKETING_CONSENT_TEXT_VERSION }, "signup"),
    ).toBe("no_action");
    // …an explicit request does (after confirmation).
    expect(
      await marketing.requestSubscription("pg@example.invalid", { source: "account_request", textVersion: MARKETING_CONSENT_TEXT_VERSION }, "explicit"),
    ).toBe("confirmation_sent");
    expect(await marketing.confirm(tokenOf(sent.length - 1))).toBe("subscribed");
    expect(await rowOf("pg@example.invalid")).toMatchObject({ subscribed: true, source: "account_request", hasUnsubscribedDate: false });
  });

  it("the database refuses a subscription without consent evidence", async () => {
    expect(
      await outcome(db, "app", `INSERT INTO "MarketingSubscription"(id, email, subscribed, "updatedAt") VALUES (gen_random_uuid(), 'x@example.invalid', true, now())`),
    ).toBe("23514");
    expect(
      await outcome(db, "app", `INSERT INTO "MarketingSubscription"(id, email, "confirmationNonce", "updatedAt") VALUES (gen_random_uuid(), 'y@example.invalid', 'n', now())`),
    ).toBe("23514");
    expect(
      await outcome(db, "app", `INSERT INTO "MarketingSubscription"(id, email, "updatedAt") VALUES (gen_random_uuid(), 'Upper@example.invalid', now())`),
    ).toBe("23514");
  });
});
