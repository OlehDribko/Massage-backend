import { describe, expect, it } from "vitest";
import {
  buildPoolConfig,
  createDatabase,
  type DatabaseOptions,
} from "../src/shared/database/database.js";
import { createCapturingLogger } from "./helpers/logs.js";

const options = (overrides: Partial<DatabaseOptions> = {}): DatabaseOptions => ({
  url: "postgresql://booking_app:p%40ss@db.example.invalid:6543/booking",
  sslMode: "verify-full",
  poolMax: 7,
  connectTimeoutMs: 4_000,
  ...overrides,
});

describe("buildPoolConfig", () => {
  it("parses the URL and verifies TLS certificates by default", () => {
    expect(buildPoolConfig(options())).toEqual({
      host: "db.example.invalid",
      port: 6543,
      user: "booking_app",
      password: "p@ss",
      database: "booking",
      ssl: { rejectUnauthorized: true },
      enableChannelBinding: false,
      max: 7,
      connectionTimeoutMillis: 4_000,
      idleTimeoutMillis: 30_000,
    });
  });

  it("disables TLS only when sslMode is explicitly disable", () => {
    const config = buildPoolConfig(
      options({ url: "postgresql://u:p@postgres/booking", sslMode: "disable" }),
    );
    expect(config.ssl).toBe(false);
    expect(config.port).toBe(5432);
  });

  it("keeps verify-full when the URL carries a compatible sslmode", () => {
    for (const mode of ["require", "verify-ca", "verify-full"]) {
      const config = buildPoolConfig(
        options({ url: `postgresql://u:p@db.example.invalid/booking?sslmode=${mode}` }),
      );
      expect(config.ssl).toEqual({ rejectUnauthorized: true });
      expect(config).not.toHaveProperty("connectionString");
    }
  });

  it("enables opportunistic SCRAM channel binding only for channel_binding=prefer over TLS", () => {
    const url = "postgresql://u:p@db.example.invalid/booking?channel_binding=prefer";
    expect(buildPoolConfig(options({ url })).enableChannelBinding).toBe(true);
    expect(
      buildPoolConfig(options({ url, sslMode: "disable" })).enableChannelBinding,
    ).toBe(false);
  });

  it("refuses to build a config from a URL that config validation would reject", () => {
    expect(() =>
      buildPoolConfig(
        options({ url: "postgresql://u:SECRET@db.example.invalid/booking?sslmode=no-verify" }),
      ),
    ).toThrow(/^DATABASE_URL parameter "sslmode" conflicts/);
  });
});

describe("createDatabase", () => {
  it("does not connect on creation and closes idempotently", async () => {
    const database = createDatabase(
      options({ url: "postgresql://u:p@127.0.0.1:5/booking", sslMode: "disable" }),
      createCapturingLogger().logger,
    );

    const first = database.close();
    const second = database.close();

    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });
});
