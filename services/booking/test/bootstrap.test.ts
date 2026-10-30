import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/bootstrap.js";
import { loadConfig, type AppConfig } from "../src/config/config.js";
import type { IdentityProvider } from "../src/modules/auth/identity.js";
import { createDatabase } from "../src/shared/database/database.js";
import { createCapturingLogger } from "./helpers/logs.js";

// Unreachable address: creating the client does not connect, and these tests
// never reach a query (validation or authentication fails first, or the route is absent).
const DUMMY_DATABASE_URL = "postgresql://user:pass@127.0.0.1:5/booking";
const database = createDatabase(
  { url: DUMMY_DATABASE_URL, sslMode: "disable", poolMax: 1, connectTimeoutMs: 1_000, queryTimeoutMs: 1_000 },
  createCapturingLogger().logger,
);

afterAll(async () => {
  await database.close();
});

const configFrom = (env: Record<string, string>): AppConfig => {
  const result = loadConfig({ DATABASE_URL: DUMMY_DATABASE_URL, ...env });
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result.config;
};

let verifyCalls = 0;
const rejectingProvider: IdentityProvider = {
  verifyIdToken: () => {
    verifyCalls += 1;
    return Promise.resolve({ ok: false, reason: "invalid" });
  },
  revokeAllSessions: () => Promise.resolve("unavailable"),
};

const appFor = (config: AppConfig) =>
  createApplication({
    config,
    logger: createCapturingLogger().logger,
    database,
    isShuttingDown: () => false,
    overrides: { identityProvider: rejectingProvider },
  });

describe("createApplication", () => {
  it("has no account, booking, admin or marketing routes without Firebase and marketing config", async () => {
    const app = appFor(configFrom({ ENABLE_LEGACY_USER_ROUTES: "false" }));

    for (const path of [
      "/api/me/sync",
      "/api/bookings",
      "/api/admin/services",
      "/api/marketing/subscriptions",
      "/api/users/subscribe",
    ]) {
      const response = await request(app).post(path).send({ email: "a@example.invalid" });
      expect(response.status).toBe(404);
    }
  });

  it("mounts /api/me behind authentication when Firebase is configured", async () => {
    const app = appFor(
      configFrom({ FIREBASE_PROJECT_ID: "massage-staging", FIREBASE_CREDENTIALS: "application-default" }),
    );

    const anonymous = await request(app).get("/api/me");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ message: "Authentication required", code: "AUTH_REQUIRED" });

    const legacy = await request(app).post("/api/users").send({});
    expect(legacy.status).toBe(404);

    // Bookings and administration require a token before anything else.
    for (const [method, path] of [
      ["get", "/api/bookings"],
      ["post", "/api/bookings"],
      ["get", "/api/admin/bookings?date=2027-03-02"],
      ["post", "/api/admin/services"],
      ["put", "/api/admin/schedule/weekly"],
    ] satisfies ["get" | "post" | "put", string][]) {
      const response = await request(app)[method](path).send({});
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: "AUTH_REQUIRED" });
    }
  });

  it("mounts /api/marketing with validation when enabled", async () => {
    const app = appFor(
      configFrom({
        ENABLE_MARKETING_SUBSCRIPTION: "true",
        BREVO_API_KEY: "dummy-brevo-key",
        EMAIL_FROM_NAME: "Test",
        EMAIL_FROM_EMAIL: "sender@example.invalid",
        ACTION_TOKEN_SECRET: "dummy-action-secret-0123456789abcdef",
        FRONTEND_URL: "http://localhost:5173",
      }),
    );

    const invalidBody = await request(app)
      .post("/api/marketing/subscriptions")
      .send({ email: "not-an-email" });
    expect(invalidBody.status).toBe(400);
    expect(invalidBody.text).toContain("Validation failed");

    const invalidToken = await request(app)
      .post("/api/marketing/subscriptions/unsubscribe")
      .send({ token: "not-a-jwt" });
    expect(invalidToken.status).toBe(400);
    expect(invalidToken.body).toEqual({ message: "Invalid or expired link", code: "INVALID_ACTION_TOKEN" });
  });

  it("health checks and public routes never need a token and never call Firebase", async () => {
    const app = appFor(
      configFrom({
        REQUIRE_FIREBASE_AUTH: "true",
        FIREBASE_PROJECT_ID: "massage-staging",
        FIREBASE_CREDENTIALS: "application-default",
        ENABLE_MARKETING_SUBSCRIPTION: "true",
        BREVO_API_KEY: "dummy-brevo-key",
        EMAIL_FROM_NAME: "Test",
        EMAIL_FROM_EMAIL: "sender@example.invalid",
        ACTION_TOKEN_SECRET: "dummy-action-secret-0123456789abcdef",
        FRONTEND_URL: "http://localhost:5173",
      }),
    );
    verifyCalls = 0;

    for (const authorization of [undefined, "Bearer stale-or-garbage"]) {
      const live = request(app).get("/health/live");
      const unsubscribe = request(app).post("/api/marketing/subscriptions/unsubscribe");
      if (authorization !== undefined) {
        void live.set("Authorization", authorization);
        void unsubscribe.set("Authorization", authorization);
      }
      expect((await live).status).toBe(200);
      // Public route: validation runs, authentication does not.
      expect((await unsubscribe.send({ token: "not-a-jwt" })).status).toBe(400);
    }
    expect(verifyCalls).toBe(0);
  });
});
