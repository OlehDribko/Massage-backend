import type { Express } from "express";
import request from "supertest";
import { z } from "zod";
import { createApplication, type NotificationsRuntime } from "../../../src/bootstrap.js";
import { loadConfig } from "../../../src/config/config.js";
import { createDatabase, type Database } from "../../../src/shared/database/database.js";
import { createFakeIdentityProvider, identity } from "../../helpers/fake-identity.js";
import { createCapturingLogger } from "../../helpers/logs.js";
import { runMigrations } from "./migrations.js";
import { CURRENT_INIT_DIR, assertDockerAvailable, startPostgres, type PostgresContainer } from "./postgres-container.js";

/**
 * Real PostgreSQL (migrations by the real runner, queries as the runtime
 * role) and the real application; only Firebase token verification is
 * replaced by a fake provider, and the server clock is controllable.
 * `apps` are independent instances with their own connection pools, like
 * separate API processes sharing one database.
 */
export type BookingStack = {
  db: PostgresContainer;
  apps: Express[];
  app: Express;
  identities: ReturnType<typeof createFakeIdentityProvider>;
  setNow: (iso: string) => void;
  advance: (ms: number) => void;
  close: () => Promise<void>;
};

export const startBookingStack = async (
  instances = 2,
  options: { notifications?: NotificationsRuntime } = {},
): Promise<BookingStack> => {
  assertDockerAvailable();
  const db = await startPostgres(CURRENT_INIT_DIR);
  await runMigrations(db);

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: db.url("app"),
    DATABASE_SSL_MODE: "disable",
    FIREBASE_PROJECT_ID: "demo-booking-it",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9",
    REQUIRE_FIREBASE_AUTH: "true",
  });
  if (!config.ok) {
    throw new Error(config.errors.join("; "));
  }

  const identities = createFakeIdentityProvider();
  let clock = Date.parse("2027-03-01T06:00:00Z");
  const databases: Database[] = [];
  const apps: Express[] = [];
  for (let i = 0; i < instances; i += 1) {
    const database = createDatabase(
      { url: db.url("app"), sslMode: "disable", poolMax: 10, connectTimeoutMs: 5_000, queryTimeoutMs: 10_000 },
      createCapturingLogger().logger,
    );
    databases.push(database);
    apps.push(
      createApplication({
        config: config.config,
        logger: createCapturingLogger().logger,
        database,
        isShuttingDown: () => false,
        notifications: options.notifications,
        overrides: { identityProvider: identities.provider, now: () => new Date(clock) },
      }),
    );
  }
  const [app] = apps;
  if (app === undefined) {
    throw new Error("no app instance");
  }

  return {
    db,
    apps,
    app,
    identities,
    setNow: (iso) => {
      clock = Date.parse(iso);
    },
    advance: (ms) => {
      clock += ms;
    },
    close: async () => {
      await Promise.all(databases.map((database) => database.close()));
      db.stop();
    },
  };
};

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Registers test users: booking-ready clients, a guest, an unverified user,
 * an incomplete profile and a verified admin. Returns their tokens.
 */
export const createUsers = async (stack: BookingStack) => {
  const { app, identities, db } = stack;
  const users = {
    clientA: "token-client-a",
    clientB: "token-client-b",
    guest: "token-guest",
    unverified: "token-unverified",
    incomplete: "token-incomplete",
    admin: "token-admin",
  };
  identities.issue(users.clientA, identity({ uid: "uid-a", email: "anna@example.invalid" }));
  identities.issue(users.clientB, identity({ uid: "uid-b", email: "boris@example.invalid" }));
  identities.issue(users.guest, identity({ uid: "uid-guest", isAnonymous: true, signInProvider: "anonymous", email: undefined, emailVerified: false }));
  identities.issue(users.unverified, identity({ uid: "uid-unverified", email: "u@example.invalid", emailVerified: false }));
  identities.issue(users.incomplete, identity({ uid: "uid-incomplete", email: "i@example.invalid" }));
  identities.issue(users.admin, identity({ uid: "uid-admin", email: "admin@example.invalid" }));

  for (const token of Object.values(users)) {
    await request(app).post("/api/me/sync").set(bearer(token)).expect(200);
  }
  const complete = async (token: string, name: string, phone: string) => {
    await request(app).patch("/api/me").set(bearer(token)).send({ name, phone }).expect(200);
  };
  await complete(users.clientA, "Anna Client", "+33612345678");
  await complete(users.clientB, "Boris Client", "+33698765432");
  await complete(users.unverified, "Unverified", "+33611111111");
  await complete(users.admin, "Studio Admin", "+33622222222");
  await db.query("admin", `UPDATE "UserProfile" SET role = 'admin' WHERE "firebaseUid" = 'uid-admin'`);
  return users;
};

export const resetCalendar = async (db: PostgresContainer): Promise<void> => {
  await db.query(
    "admin",
    `TRUNCATE "NotificationDelivery", "NotificationEvent", "OutboxEvent", "BookingTimeChange", "Booking", "Service", "ScheduleExceptionInterval", "ScheduleException", "WeeklyScheduleInterval"`,
  );
};

const idSchema = z.object({ id: z.uuid() });
export const serviceIdOf = (response: request.Response): string => {
  const body: unknown = response.body;
  return z.object({ service: idSchema }).parse(body).service.id;
};
export const bookingIdOf = (response: request.Response): string => {
  const body: unknown = response.body;
  return z.object({ booking: idSchema }).parse(body).booking.id;
};

export const countRows = async (db: PostgresContainer, sql: string): Promise<number> => {
  const result = await db.query("admin", sql);
  const row: unknown = result.rows[0];
  return z.object({ n: z.number() }).parse(row).n;
};
