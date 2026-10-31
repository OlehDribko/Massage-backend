import type { Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApplication } from "../../src/bootstrap.js";
import { loadConfig } from "../../src/config/config.js";
import { createFirebaseIdentityProvider } from "../../src/integrations/firebase/firebase-identity-provider.js";
import type { MarketingMailer } from "../../src/modules/email/service/email.service.js";
import { MARKETING_CONSENT_TEXT_VERSION } from "../../src/modules/marketing/consent.js";
import { createDatabase, type Database } from "../../src/shared/database/database.js";
import { killRunningChildren, startTsProcess } from "../helpers/child-process.js";
import { createCapturingLogger, type CapturedLogs, type LogEntry } from "../helpers/logs.js";
import {
  EMULATOR_PROJECT_ID,
  clearEmulatorAccounts,
  client,
  createEmulatorAdmin,
  emulatorHost,
  nextSecond,
  withClaims,
} from "./helpers/firebase-emulator.js";
import { runMigrations } from "./helpers/migrations.js";
import {
  CURRENT_INIT_DIR,
  assertDockerAvailable,
  outcome,
  startPostgres,
  type PostgresContainer,
} from "./helpers/postgres-container.js";

// Real stack except Google itself: PostgreSQL (migrations applied by the real
// runner, queries as the runtime role booking_app), Firebase Admin SDK in
// emulator mode, Firebase Auth Emulator acting as the client SDK.
// Verified here: anonymous sessions, linking, credential conflicts, disabled
// users, revoked sessions, expiry, foreign projects, concurrency, role assignment.
// NOT verified here (needs a real Firebase project): Google's token signatures,
// real Google sign-in, real email delivery by Firebase.

const PASSWORD = "integration-Password-1";
const TOKEN_FRAGMENT_LENGTH = 40;

let db: PostgresContainer;
let database: Database;
let app: Express;
let logs: CapturedLogs;
const admin = createEmulatorAdmin();
const mails: { email: string; url: string }[] = [];
const mailer: MarketingMailer = {
  sendConfirmationRequest: (email, url) => {
    mails.push({ email, url });
    return Promise.resolve({ kind: "accepted" });
  },
  sendSubscriptionConfirmed: () => Promise.resolve({ kind: "accepted" }),
};

const profileResponseSchema = z.object({ profile: z.object({ id: z.uuid() }) });

/** Our profile id from a /api/me response. */
const idOf = (response: request.Response): string => {
  const body: unknown = response.body;
  return profileResponseSchema.parse(body).profile.id;
};

const hasReason = (entries: LogEntry[], reason: string): boolean =>
  entries.some((entry) => entry.reason === reason);

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const sync = (token: string) => request(app).post("/api/me/sync").set(bearer(token));

const profileCount = async (): Promise<number> => {
  const result = await db.query("admin", `SELECT count(*)::int AS n FROM "UserProfile"`);
  const row: unknown = result.rows[0];
  return typeof row === "object" && row !== null && "n" in row && typeof row.n === "number" ? row.n : -1;
};

beforeAll(async () => {
  assertDockerAvailable();
  emulatorHost();
  db = await startPostgres(CURRENT_INIT_DIR);
  await runMigrations(db);

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: db.url("app"),
    DATABASE_SSL_MODE: "disable",
    FIREBASE_PROJECT_ID: EMULATOR_PROJECT_ID,
    FIREBASE_AUTH_EMULATOR_HOST: emulatorHost(),
    REQUIRE_FIREBASE_AUTH: "true",
    ENABLE_MARKETING_SUBSCRIPTION: "true",
    BREVO_API_KEY: "unused-in-tests",
    EMAIL_FROM_NAME: "Test",
    EMAIL_FROM_EMAIL: "sender@example.invalid",
    ACTION_TOKEN_SECRET: "integration-action-secret-0123456789abcdef",
    FRONTEND_URL: "https://front.example.invalid",
  });
  if (!config.ok) {
    throw new Error(config.errors.join("; "));
  }
  logs = createCapturingLogger();
  database = createDatabase(
    { url: db.url("app"), sslMode: "disable", poolMax: 10, connectTimeoutMs: 5_000, queryTimeoutMs: 10_000 },
    logs.logger,
  );
  // The real Firebase adapter (no override); only the email provider is replaced.
  app = createApplication({
    config: config.config,
    logger: logs.logger,
    database,
    isShuttingDown: () => false,
    overrides: { marketingMailer: mailer },
  });
});

afterEach(async () => {
  await killRunningChildren();
});

afterAll(async () => {
  await clearEmulatorAccounts();
  await admin.close();
  await database.close();
  db.stop();
});

describe("guest → registered client (Auth Emulator + PostgreSQL)", () => {
  it("keeps one profile from anonymous session through linking, verification and completion", async () => {
    const guest = await client.signInAnonymously();
    const asGuest = await sync(guest.idToken);
    expect(asGuest.status).toBe(200);
    expect(asGuest.body).toMatchObject({
      profile: { authState: "anonymous", email: null, role: "client" },
      bookingReadiness: { ready: false, blockers: ["anonymous_session", "email_not_verified", "name_missing", "phone_missing"] },
    });
    const profileId = idOf(asGuest);

    // linkWithCredential: Firebase keeps the UID, so our profile is kept too.
    // Adding a password counts as an account change: Firebase revokes earlier
    // sessions, and the token returned by the link keeps the anonymous
    // sign-in's auth_time (observed in the Auth Emulator), so it is rejected.
    // The frontend therefore signs in again with the new credentials.
    await nextSecond();
    const linked = await client.linkEmailPassword(guest.idToken, "linked@example.invalid", PASSWORD);
    if ("error" in linked) {
      throw new Error(linked.error);
    }
    expect(linked.localId).toBe(guest.localId);
    expect((await sync(linked.idToken)).body).toMatchObject({ code: "SESSION_REVOKED" });

    const signedIn = await client.signIn("linked@example.invalid", PASSWORD);
    expect(signedIn.localId).toBe(guest.localId);
    const asRegistered = await sync(signedIn.idToken);
    expect(asRegistered.body).toMatchObject({
      profile: { id: profileId, authState: "registered", email: "linked@example.invalid", emailVerified: false },
      bookingReadiness: { blockers: ["email_not_verified", "name_missing", "phone_missing"] },
    });

    // The user verifies the email (Firebase's link); the old token still says
    // unverified and must not count, a fresh token does.
    await admin.auth.updateUser(guest.localId, { emailVerified: true });
    const stale = await sync(signedIn.idToken);
    expect(stale.body).toMatchObject({ profile: { emailVerified: false } });
    await nextSecond();
    const fresh = await client.signIn("linked@example.invalid", PASSWORD);
    const verified = await sync(fresh.idToken);
    expect(verified.body).toMatchObject({ profile: { id: profileId, emailVerified: true } });

    const completed = await request(app)
      .patch("/api/me")
      .set(bearer(fresh.idToken))
      .send({ name: "Léa Martin", phone: "+33 6 12 34 56 78" });
    expect(completed.body).toMatchObject({
      profile: { id: profileId, name: "Léa Martin", phone: "+33612345678" },
      bookingReadiness: { ready: true, blockers: [] },
    });

    // An older token arriving late does not roll verification back.
    expect((await sync(signedIn.idToken)).body).toMatchObject({ profile: { emailVerified: true } });
  });

  it("links a guest to Google without losing the profile", async () => {
    const guest = await client.signInAnonymously();
    const before = await sync(guest.idToken);

    const google = await client.signInWithGoogle(
      { sub: "google-guest-1", email: "guest.google@example.invalid", email_verified: true },
      guest.idToken,
    );
    if ("error" in google) {
      throw new Error(google.error);
    }
    expect(google.localId).toBe(guest.localId);

    const after = await sync(google.idToken);
    expect(after.body).toMatchObject({
      profile: {
        id: idOf(before),
        authState: "registered",
        signInProvider: "google.com",
        email: "guest.google@example.invalid",
        emailVerified: true,
      },
    });
  });

  it("refuses to link credentials that belong to another account and merges nothing", async () => {
    const owner = await client.signUp("taken@example.invalid", PASSWORD);
    const ownerProfile = await sync(owner.idToken);
    const guest = await client.signInAnonymously();
    const guestProfile = await sync(guest.idToken);
    const countBefore = await profileCount();

    const conflict = await client.linkEmailPassword(guest.idToken, "taken@example.invalid", "other-Password-2");
    expect(conflict).toEqual({ error: "EMAIL_EXISTS" });

    // The frontend then signs in to the existing account instead: two separate
    // profiles remain; nothing is merged by email.
    const again = await sync(guest.idToken);
    expect(again.body).toMatchObject({ profile: { id: idOf(guestProfile), authState: "anonymous", email: null } });
    const ownerAgain = await sync((await client.signIn("taken@example.invalid", PASSWORD)).idToken);
    expect(ownerAgain.body).toMatchObject({ profile: { id: idOf(ownerProfile) } });
    expect(await profileCount()).toBe(countBefore);
  });
});

describe("sign-up with the marketing checkbox (emulator + PostgreSQL)", () => {
  const optIn = { marketingOptIn: true, marketingConsentTextVersion: MARKETING_CONSENT_TEXT_VERSION };

  it("email + password and Google: one confirmation email each, status false until confirmed", async () => {
    const password = await client.signUp("checkbox@example.invalid", PASSWORD);
    const google = await client.signInWithGoogle({ sub: "google-checkbox", email: "checkbox.google@example.invalid", email_verified: true });
    if ("error" in google) {
      throw new Error(google.error);
    }

    const passwordSyncs = await Promise.all(
      Array.from({ length: 8 }, () => request(app).post("/api/me/sync").set(bearer(password.idToken)).send(optIn)),
    );
    const googleSync = await request(app).post("/api/me/sync").set(bearer(google.idToken)).send(optIn);
    await request(app).post("/api/me/sync").set(bearer(google.idToken)).send(optIn);

    expect(passwordSyncs.every((response) => response.status === 200)).toBe(true);
    expect(mails.filter((mail) => mail.email === "checkbox@example.invalid")).toHaveLength(1);
    expect(mails.filter((mail) => mail.email === "checkbox.google@example.invalid")).toHaveLength(1);
    expect(passwordSyncs[0]?.body).toMatchObject({ profile: { emailVerified: false }, marketing: null });
    expect(googleSync.body).toMatchObject({
      marketing: { subscribed: false, pendingConfirmation: true },
      marketingOptIn: { outcome: "confirmation_sent" },
    });

    // Firebase email verification does not subscribe.
    await admin.auth.updateUser(password.localId, { emailVerified: true });
    await nextSecond();
    const verified = await client.signIn("checkbox@example.invalid", PASSWORD);
    expect((await sync(verified.idToken)).body).toMatchObject({ marketing: { subscribed: false } });
  });
});

describe("token rejection with the real Admin SDK (emulator)", () => {
  it("disabled user → 403 ACCOUNT_DISABLED", async () => {
    const user = await client.signUp("disabled@example.invalid", PASSWORD);
    expect((await sync(user.idToken)).status).toBe(200);

    await admin.auth.updateUser(user.localId, { disabled: true });

    const response = await sync(user.idToken);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ message: "Account disabled", code: "ACCOUNT_DISABLED" });
  });

  it("sign-out everywhere revokes current tokens → 401 SESSION_REVOKED", async () => {
    const user = await client.signUp("revoke@example.invalid", PASSWORD);
    await sync(user.idToken);
    await nextSecond();

    const revoke = await request(app).post("/api/me/sessions/revoke").set(bearer(user.idToken));
    expect(revoke.status).toBe(204);

    const response = await sync(user.idToken);
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "SESSION_REVOKED" });

    await nextSecond();
    const again = await client.signIn("revoke@example.invalid", PASSWORD);
    expect((await sync(again.idToken)).status).toBe(200);
  });

  it("expired token → 401 TOKEN_EXPIRED; deleted user and malformed token → 401 INVALID_TOKEN", async () => {
    const user = await client.signUp("expired@example.invalid", PASSWORD);
    const past = Math.floor(Date.now() / 1000) - 7200;
    const expired = withClaims(user.idToken, { iat: past, auth_time: past, exp: past + 3600 });
    expect((await sync(expired)).body).toMatchObject({ code: "TOKEN_EXPIRED" });

    await admin.auth.deleteUser(user.localId);
    expect((await sync(user.idToken)).body).toMatchObject({ code: "INVALID_TOKEN" });
    expect((await sync("not.a.token")).body).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("a token of another Firebase project is invalid", async () => {
    const otherLogs = createCapturingLogger();
    const provider = createFirebaseIdentityProvider(
      { projectId: "demo-other-project", credentials: { kind: "emulator", host: emulatorHost() } },
      otherLogs.logger,
    );
    const user = await client.signUp("project@example.invalid", PASSWORD);

    expect(await provider.verifyIdToken(user.idToken)).toEqual({ ok: false, reason: "invalid" });
    await provider.close();
  });

  it("never writes tokens to logs", () => {
    // Any JWT-like value: two long base64url segments joined by a dot.
    const jwtLike = new RegExp(`[A-Za-z0-9_-]{${TOKEN_FRAGMENT_LENGTH},}\\.[A-Za-z0-9_-]{${TOKEN_FRAGMENT_LENGTH},}`);
    expect(logs.raw()).not.toMatch(jwtLike);
  });
});

describe("profiles in PostgreSQL", () => {
  it("creates exactly one profile under concurrent first requests", async () => {
    const user = await client.signUp("concurrent@example.invalid", PASSWORD);

    const responses = await Promise.all(Array.from({ length: 25 }, () => sync(user.idToken)));

    expect(responses.map((response) => response.status)).toEqual(Array(25).fill(200));
    const ids = new Set(responses.map(idOf));
    expect(ids.size).toBe(1);
    const rows = await db.query("admin", `SELECT count(*)::int AS n FROM "UserProfile" WHERE email = 'concurrent@example.invalid'`);
    expect(rows.rows).toEqual([{ n: 1 }]);
  });

  it("the database refuses an anonymous admin and malformed phone numbers", async () => {
    const guest = await client.signInAnonymously();
    await sync(guest.idToken);

    expect(await outcome(db, "app", `UPDATE "UserProfile" SET role = 'admin' WHERE "firebaseUid" = '${guest.localId}'`)).toBe("23514");
    expect(await outcome(db, "app", `UPDATE "UserProfile" SET "phoneE164" = '0612345678' WHERE "firebaseUid" = '${guest.localId}'`)).toBe("23514");
  });
});

describe("assign-role command (owner-only, no HTTP route)", () => {
  const runAssign = async (args: string[]) => {
    const child = startTsProcess(
      "src/admin/assign-role.ts",
      { DATABASE_URL: db.url("app"), DATABASE_SSL_MODE: "disable" },
      args,
    );
    const exit = await child.exited;
    return { code: exit.code, entries: child.entries(), output: child.output() };
  };

  it("grants admin only to a verified, registered profile whose email matches", async () => {
    const user = await client.signUp("owner@example.invalid", PASSWORD);
    const synced = await sync(user.idToken);
    const profileId = idOf(synced);

    const unverified = await runAssign(["--profile-id", profileId, "--email", "owner@example.invalid", "--role", "admin", "--apply"]);
    expect(unverified.code).toBe(2);
    expect(hasReason(unverified.entries, "email_not_verified")).toBe(true);

    await admin.auth.updateUser(user.localId, { emailVerified: true });
    await nextSecond();
    const fresh = await client.signIn("owner@example.invalid", PASSWORD);
    await sync(fresh.idToken);

    const mismatch = await runAssign(["--profile-id", profileId, "--email", "someone@example.invalid", "--role", "admin", "--apply"]);
    expect(mismatch.code).toBe(2);
    expect(hasReason(mismatch.entries, "email_mismatch")).toBe(true);

    const dryRun = await runAssign(["--profile-id", profileId, "--email", "OWNER@example.invalid", "--role", "admin"]);
    expect(dryRun.code).toBe(0);
    expect((await request(app).get("/api/me").set(bearer(fresh.idToken))).body).toMatchObject({ profile: { role: "client" } });

    const applied = await runAssign(["--profile-id", profileId, "--email", "owner@example.invalid", "--role", "admin", "--apply"]);
    expect(applied.code).toBe(0);
    expect(applied.output).not.toContain("postgresql://");

    const asAdmin = await request(app).get("/api/me").set(bearer(fresh.idToken));
    expect(asAdmin.body).toMatchObject({
      profile: { role: "admin" },
      bookingReadiness: { ready: false, blockers: ["not_a_client", "name_missing", "phone_missing"] },
    });

    // The user cannot change it back (or anything privileged) through the API.
    const patch = await request(app).patch("/api/me").set(bearer(fresh.idToken)).send({ role: "client" });
    expect(patch.status).toBe(400);
  });

  it("refuses an anonymous profile and an unknown id", async () => {
    const guest = await client.signInAnonymously();
    const synced = await sync(guest.idToken);

    const anonymous = await runAssign(["--profile-id", idOf(synced), "--email", "x@example.invalid", "--role", "admin", "--apply"]);
    expect(anonymous.code).toBe(2);

    const unknown = await runAssign(["--profile-id", "00000000-0000-4000-8000-000000000000", "--email", "x@example.invalid", "--role", "admin"]);
    expect(unknown.code).toBe(2);
    expect(hasReason(unknown.entries, "profile_not_found")).toBe(true);
  });
});
