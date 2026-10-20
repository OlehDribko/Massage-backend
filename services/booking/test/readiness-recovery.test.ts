import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplication } from "../src/bootstrap.js";
import { loadConfig } from "../src/config/config.js";
import { createDatabase, type Database } from "../src/shared/database/database.js";
import { startFakePostgres, type FakePostgres } from "./helpers/fake-postgres.js";
import { createCapturingLogger } from "./helpers/logs.js";

const READINESS_TIMEOUT_MS = 300;

let fake: FakePostgres;
let database: Database;

beforeEach(async () => {
  fake = await startFakePostgres();
  database = createDatabase(
    {
      url: `postgresql://user:pass@127.0.0.1:${fake.port}/booking`,
      sslMode: "disable",
      poolMax: 5,
      connectTimeoutMs: 2_000,
      // Business-query limit stays long; readiness uses its own short limit.
      queryTimeoutMs: 30_000,
    },
    createCapturingLogger().logger,
  );
});

afterEach(async () => {
  await database.close();
  await fake.close();
});

const appFor = () => {
  const loaded = loadConfig({
    DATABASE_URL: `postgresql://user:pass@127.0.0.1:${fake.port}/booking`,
    DATABASE_SSL_MODE: "disable",
    READINESS_TIMEOUT_MS: String(READINESS_TIMEOUT_MS),
  });
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("; "));
  }
  return createApplication({
    config: loaded.config,
    logger: createCapturingLogger().logger,
    database,
    isShuttingDown: () => false,
  });
};

describe("database ping (driver level)", () => {
  it("fails the hung query itself and destroys that connection", async () => {
    fake.setMode("hang");

    await expect(database.ping(150)).rejects.toThrow("Query read timeout");
    // The pool discarded the client and its socket was closed.
    await fake.waitFor(() => fake.closedConnections() === 1);
  });
});

describe("/health/ready with a connected but unresponsive database", () => {
  it("returns 503 in time, does not stay blocked and recovers without restart", async () => {
    const app = appFor();

    expect((await request(app).get("/health/ready")).status).toBe(200);
    expect(fake.queriesReceived()).toBe(1);

    fake.setMode("hang");

    // (a) the HTTP response is bounded.
    const startedAt = Date.now();
    const hung = await request(app).get("/health/ready");
    expect(hung.status).toBe(503);
    expect(Date.now() - startedAt).toBeLessThan(READINESS_TIMEOUT_MS + 1_000);
    expect(fake.queriesReceived()).toBe(2);

    // (b)+(c) the driver gives up and the stuck connection is destroyed.
    await fake.waitFor(() => fake.closedConnections() === 1);

    // The hung check no longer blocks: the next probe sends a new query.
    expect((await request(app).get("/health/ready")).status).toBe(503);
    expect(fake.queriesReceived()).toBe(3);
    await fake.waitFor(() => fake.closedConnections() === 2);

    // Concurrent probes share one in-flight check: no unbounded pile-up.
    const burst = await Promise.all(
      Array.from({ length: 10 }, () => request(app).get("/health/ready")),
    );
    expect(burst.every((response) => response.status === 503)).toBe(true);
    expect(fake.queriesReceived()).toBe(4);
    await fake.waitFor(() => fake.closedConnections() === 3);

    // The database recovers: readiness returns to 200 with the same app.
    fake.setMode("respond");
    const recovered = await request(app).get("/health/ready");
    expect(recovered.status).toBe(200);
    expect(fake.queriesReceived()).toBe(5);
  });
});
