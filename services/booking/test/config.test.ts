import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../src/config/config.js";

const DB_URL = "postgresql://user:db-secret-value@127.0.0.1:5432/booking";

const legacyEnv = {
  ENABLE_LEGACY_USER_ROUTES: "true",
  BREVO_API_KEY: "brevo-secret-value",
  EMAIL_FROM_NAME: "Test Sender",
  EMAIL_FROM_EMAIL: "sender@example.invalid",
  ACTION_TOKEN_SECRET: "action-secret-value",
  FRONTEND_URL: "http://localhost:5173",
};

const expectConfig = (env: Record<string, string | undefined>): AppConfig => {
  const result = loadConfig(env);
  if (!result.ok) {
    throw new Error(`expected valid config, got: ${result.errors.join("; ")}`);
  }
  return result.config;
};

const expectErrors = (env: Record<string, string | undefined>): string[] => {
  const result = loadConfig(env);
  if (result.ok) {
    throw new Error("expected invalid config");
  }
  return result.errors;
};

describe("loadConfig", () => {
  it("applies defaults with only DATABASE_URL set", () => {
    const config = expectConfig({ DATABASE_URL: DB_URL });

    expect(config).toEqual({
      nodeEnv: "production",
      port: 3001,
      logLevel: "info",
      databaseUrl: DB_URL,
      databaseSslMode: "verify-full",
      databasePoolMax: 5,
      databaseConnectTimeoutMs: 5_000,
      appVersion: undefined,
      corsOrigin: undefined,
      shutdownTimeoutMs: 10_000,
      readinessTimeoutMs: 2_000,
      legacyUserRoutes: { enabled: false },
    });
  });

  it.each(["1", "3001", "8080", "65535"])("accepts PORT=%s", (port) => {
    expect(expectConfig({ DATABASE_URL: DB_URL, PORT: port }).port).toBe(Number(port));
  });

  it.each(["0", "65536", "abc", "80.5", "-1", "3001abc"])("rejects PORT=%j", (port) => {
    const errors = expectErrors({ DATABASE_URL: DB_URL, PORT: port });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^PORT:/);
  });

  it("treats an empty PORT as unset", () => {
    expect(expectConfig({ DATABASE_URL: DB_URL, PORT: " " }).port).toBe(3001);
  });

  it("requires DATABASE_URL without echoing invalid values", () => {
    const missing = expectErrors({});
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/^DATABASE_URL:/);

    const errors = expectErrors({ DATABASE_URL: "mysql://u:mysql-secret@h/db" });
    expect(errors.join(" ")).toContain("DATABASE_URL");
    expect(errors.join(" ")).not.toContain("mysql-secret");
  });

  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["FALSE", false],
    [" false ", false],
    ["true", true],
    ["True", true],
  ])("parses ENABLE_LEGACY_USER_ROUTES=%j as %s", (value, expected) => {
    const config = expectConfig({
      ...legacyEnv,
      DATABASE_URL: DB_URL,
      ENABLE_LEGACY_USER_ROUTES: value,
    });
    expect(config.legacyUserRoutes.enabled).toBe(expected);
  });

  it.each(["1", "0", "yes", "no", "on"])(
    "rejects ambiguous ENABLE_LEGACY_USER_ROUTES=%j",
    (value) => {
      const errors = expectErrors({ DATABASE_URL: DB_URL, ENABLE_LEGACY_USER_ROUTES: value });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^ENABLE_LEGACY_USER_ROUTES:/);
    },
  );

  it("does not require Brevo, token secret or FRONTEND_URL when legacy routes are disabled", () => {
    const config = expectConfig({ DATABASE_URL: DB_URL, ENABLE_LEGACY_USER_ROUTES: "false" });
    expect(config.legacyUserRoutes).toEqual({ enabled: false });
  });

  it("requires legacy settings when enabled and never prints their values", () => {
    const errors = expectErrors({
      DATABASE_URL: DB_URL,
      ENABLE_LEGACY_USER_ROUTES: "true",
      ACTION_TOKEN_SECRET: "action-secret-value",
    });
    const text = errors.join("\n");

    for (const name of ["BREVO_API_KEY", "EMAIL_FROM_NAME", "EMAIL_FROM_EMAIL", "FRONTEND_URL"]) {
      expect(text).toContain(name);
    }
    expect(text).not.toContain("ACTION_TOKEN_SECRET:");
    expect(text).not.toContain("action-secret-value");
    expect(text).not.toContain("db-secret-value");
  });

  it("builds the legacy config when everything is present", () => {
    const config = expectConfig({ ...legacyEnv, DATABASE_URL: DB_URL });
    expect(config.legacyUserRoutes).toEqual({
      enabled: true,
      brevoApiKey: "brevo-secret-value",
      emailFromName: "Test Sender",
      emailFromEmail: "sender@example.invalid",
      actionTokenSecret: "action-secret-value",
      frontendUrl: "http://localhost:5173",
    });
    expect(config.corsOrigin).toBe("http://localhost:5173");
  });

  it("validates LOG_LEVEL, APP_VERSION and timeouts", () => {
    const config = expectConfig({
      DATABASE_URL: DB_URL,
      LOG_LEVEL: "DEBUG",
      APP_VERSION: "1.2.3+abc",
      SHUTDOWN_TIMEOUT_MS: "5000",
      READINESS_TIMEOUT_MS: "250",
    });
    expect(config.logLevel).toBe("debug");
    expect(config.appVersion).toBe("1.2.3+abc");
    expect(config.shutdownTimeoutMs).toBe(5000);
    expect(config.readinessTimeoutMs).toBe(250);

    const errors = expectErrors({
      DATABASE_URL: DB_URL,
      LOG_LEVEL: "verbose",
      APP_VERSION: "has spaces",
      SHUTDOWN_TIMEOUT_MS: "0",
    });
    expect(errors.map((error) => error.split(":")[0])).toEqual([
      "LOG_LEVEL",
      "APP_VERSION",
      "SHUTDOWN_TIMEOUT_MS",
    ]);
  });

  it("keeps TLS verification on unless DATABASE_SSL_MODE=disable is explicit", () => {
    expect(expectConfig({ DATABASE_URL: DB_URL }).databaseSslMode).toBe("verify-full");
    expect(
      expectConfig({ DATABASE_URL: DB_URL, DATABASE_SSL_MODE: "disable" }).databaseSslMode,
    ).toBe("disable");

    for (const value of ["require", "no-verify", "prefer", "off"]) {
      const errors = expectErrors({ DATABASE_URL: DB_URL, DATABASE_SSL_MODE: value });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^DATABASE_SSL_MODE:/);
    }
  });

  it("validates pool size and connect timeout", () => {
    const config = expectConfig({
      DATABASE_URL: DB_URL,
      DATABASE_POOL_MAX: "10",
      DATABASE_CONNECT_TIMEOUT_MS: "3000",
    });
    expect(config.databasePoolMax).toBe(10);
    expect(config.databaseConnectTimeoutMs).toBe(3000);

    for (const value of ["0", "51", "x"]) {
      expect(expectErrors({ DATABASE_URL: DB_URL, DATABASE_POOL_MAX: value })[0]).toMatch(
        /^DATABASE_POOL_MAX:/,
      );
    }
  });
});
