import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApplication } from "../src/bootstrap.js";
import { loadConfig, type AppConfig } from "../src/config/config.js";
import { createDatabase } from "../src/shared/database/database.js";
import { createCapturingLogger } from "./helpers/logs.js";

// Unreachable address: creating the client does not connect, and these tests
// never reach a query (validation fails first or the route is absent).
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

const appFor = (config: AppConfig) =>
  createApplication({
    config,
    logger: createCapturingLogger().logger,
    database,
    isShuttingDown: () => false,
  });

describe("createApplication", () => {
  it("does not mount /api/users when the legacy flag is unset or false", async () => {
    for (const env of [{}, { ENABLE_LEGACY_USER_ROUTES: "false" }]) {
      const app = appFor(configFrom(env));

      const response = await request(app)
        .post("/api/users/subscribe")
        .send({ email: "not-an-email" });

      expect(response.status).toBe(404);
    }
  });

  it("mounts the legacy routes with their validation when the flag is true", async () => {
    const app = appFor(
      configFrom({
        ENABLE_LEGACY_USER_ROUTES: "true",
        BREVO_API_KEY: "dummy-brevo-key",
        EMAIL_FROM_NAME: "Test",
        EMAIL_FROM_EMAIL: "sender@example.invalid",
        ACTION_TOKEN_SECRET: "dummy-action-secret",
        FRONTEND_URL: "http://localhost:5173",
      }),
    );

    const invalidBody = await request(app)
      .post("/api/users/subscribe")
      .send({ email: "not-an-email" });
    expect(invalidBody.status).toBe(400);
    expect(invalidBody.text).toContain("Validation failed");

    const invalidToken = await request(app)
      .post("/api/users/verify-email")
      .send({ token: "not-a-jwt" });
    expect(invalidToken.status).toBe(400);
    expect(invalidToken.text).toBe('{"message":"Invalid action token"}');
  });
});
