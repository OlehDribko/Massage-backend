import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../src/config/config.js";

const DB_URL = "postgresql://user:db-secret-value@127.0.0.1:5432/booking";

const ACTION_SECRET = "action-secret-value-0123456789abcdef";

const marketingEnv = {
  ENABLE_MARKETING_SUBSCRIPTION: "true",
  BREVO_API_KEY: "brevo-secret-value",
  EMAIL_FROM_NAME: "Test Sender",
  EMAIL_FROM_EMAIL: "sender@example.invalid",
  ACTION_TOKEN_SECRET: ACTION_SECRET,
  FRONTEND_URL: "http://localhost:5173",
};

const PRIVATE_KEY_SENTINEL = "PRIVATE_KEY_SENTINEL";

const serviceAccountJson = (projectId: string, overrides: Record<string, string> = {}) =>
  JSON.stringify({
    type: "service_account",
    project_id: projectId,
    private_key_id: "kid",
    private_key: `-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY_SENTINEL}\n-----END PRIVATE KEY-----\n`,
    client_email: `api@${projectId}.iam.gserviceaccount.com`,
    ...overrides,
  });

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
      databaseQueryTimeoutMs: 30_000,
      appVersion: undefined,
      corsOrigin: undefined,
      shutdownTimeoutMs: 10_000,
      readinessTimeoutMs: 2_000,
      firebase: undefined,
      marketing: undefined,
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

  it.each([undefined, "", "false", "FALSE", " false "])(
    "accepts the removed ENABLE_LEGACY_USER_ROUTES only as unset or false (%j)",
    (value) => {
      expectConfig({ DATABASE_URL: DB_URL, ENABLE_LEGACY_USER_ROUTES: value });
    },
  );

  it.each(["true", "True", "1", "yes"])(
    "refuses ENABLE_LEGACY_USER_ROUTES=%j: the legacy routes no longer exist",
    (value) => {
      const errors = expectErrors({ DATABASE_URL: DB_URL, ENABLE_LEGACY_USER_ROUTES: value });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^ENABLE_LEGACY_USER_ROUTES: legacy \/api\/users routes were removed/);
    },
  );

  it.each([
    [undefined, false],
    ["false", false],
    ["TRUE", true],
  ])("parses ENABLE_MARKETING_SUBSCRIPTION=%j", (value, enabled) => {
    const config = expectConfig({ ...marketingEnv, DATABASE_URL: DB_URL, ENABLE_MARKETING_SUBSCRIPTION: value });
    expect(config.marketing !== undefined).toBe(enabled);
  });

  it("requires marketing settings when enabled and never prints their values", () => {
    const errors = expectErrors({
      DATABASE_URL: DB_URL,
      ENABLE_MARKETING_SUBSCRIPTION: "true",
      ACTION_TOKEN_SECRET: "short-secret-value",
    });
    const text = errors.join("\n");

    for (const name of ["BREVO_API_KEY", "EMAIL_FROM_NAME", "EMAIL_FROM_EMAIL", "FRONTEND_URL"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("ACTION_TOKEN_SECRET: must be at least 32 characters");
    expect(text).not.toContain("short-secret-value");
    expect(text).not.toContain("db-secret-value");
  });

  it("builds the marketing config when everything is present", () => {
    const config = expectConfig({ ...marketingEnv, DATABASE_URL: DB_URL });
    expect(config.marketing).toEqual({
      brevoApiKey: "brevo-secret-value",
      emailFromName: "Test Sender",
      emailFromEmail: "sender@example.invalid",
      actionTokenSecret: ACTION_SECRET,
      frontendUrl: "http://localhost:5173",
    });
    expect(config.corsOrigin).toBe("http://localhost:5173");
  });

  describe("Firebase", () => {
    it("leaves authentication off (no /api/me) without FIREBASE_PROJECT_ID", () => {
      expect(expectConfig({ DATABASE_URL: DB_URL }).firebase).toBeUndefined();
    });

    it("requires FIREBASE_PROJECT_ID when other FIREBASE_* variables are set", () => {
      const errors = expectErrors({ DATABASE_URL: DB_URL, FIREBASE_CREDENTIALS: "application-default" });
      expect(errors).toEqual(["FIREBASE_PROJECT_ID: required when other FIREBASE_* variables are set"]);
    });

    it.each(["Massage", "ab", "-massage-staging", "massage_staging", "a".repeat(31)])(
      "rejects the project id %j",
      (projectId) => {
        const errors = expectErrors({ DATABASE_URL: DB_URL, FIREBASE_PROJECT_ID: projectId });
        expect(errors[0]).toMatch(/^FIREBASE_PROJECT_ID:/);
      },
    );

    it("uses application default credentials", () => {
      const config = expectConfig({
        DATABASE_URL: DB_URL,
        FIREBASE_PROJECT_ID: "massage-staging",
        FIREBASE_CREDENTIALS: "application-default",
      });
      expect(config.firebase).toEqual({
        projectId: "massage-staging",
        credentials: { kind: "application-default" },
      });
    });

    it("requires explicit credentials outside the emulator", () => {
      for (const credentials of [undefined, "none"]) {
        const errors = expectErrors({
          DATABASE_URL: DB_URL,
          FIREBASE_PROJECT_ID: "massage-staging",
          FIREBASE_CREDENTIALS: credentials,
        });
        expect(errors[0]).toMatch(/^FIREBASE_CREDENTIALS: must be application-default or service-account-json/);
      }
    });

    it("parses a service account key of the same project", () => {
      const config = expectConfig({
        DATABASE_URL: DB_URL,
        FIREBASE_PROJECT_ID: "massage-staging",
        FIREBASE_CREDENTIALS: "service-account-json",
        FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson("massage-staging"),
      });
      expect(config.firebase?.credentials.kind).toBe("service-account");
    });

    it.each([
      ["missing", undefined, /required when FIREBASE_CREDENTIALS=service-account-json/],
      ["not JSON", `{${PRIVATE_KEY_SENTINEL}`, /must be the JSON key file of a service account/],
      ["another project", serviceAccountJson("massage-production"), /project_id does not match FIREBASE_PROJECT_ID/],
      ["not a service account", serviceAccountJson("massage-staging", { type: "authorized_user" }), /type service_account/],
      ["no PEM key", serviceAccountJson("massage-staging", { private_key: PRIVATE_KEY_SENTINEL }), /PEM private key/],
    ])("rejects a service account key (%s) without printing it", (_label, json, expected) => {
      const errors = expectErrors({
        DATABASE_URL: DB_URL,
        FIREBASE_PROJECT_ID: "massage-staging",
        FIREBASE_CREDENTIALS: "service-account-json",
        FIREBASE_SERVICE_ACCOUNT_JSON: json,
      });
      const text = errors.join("\n");
      expect(text).toMatch(expected);
      expect(text).not.toContain(PRIVATE_KEY_SENTINEL);
      expect(text).not.toContain("iam.gserviceaccount.com");
    });

    it("rejects a service account key next to application default credentials", () => {
      const errors = expectErrors({
        DATABASE_URL: DB_URL,
        FIREBASE_PROJECT_ID: "massage-staging",
        FIREBASE_CREDENTIALS: "application-default",
        FIREBASE_SERVICE_ACCOUNT_JSON: serviceAccountJson("massage-staging"),
      });
      expect(errors[0]).toMatch(/^FIREBASE_SERVICE_ACCOUNT_JSON: set only with/);
    });

    it("refuses the Auth Emulator in production, even without a project id", () => {
      for (const extra of [{}, { FIREBASE_PROJECT_ID: "demo-massage" }]) {
        const errors = expectErrors({
          DATABASE_URL: DB_URL,
          NODE_ENV: "production",
          FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
          ...extra,
        });
        expect(errors[0]).toMatch(/^FIREBASE_AUTH_EMULATOR_HOST: must not be set when NODE_ENV=production/);
      }
    });

    it("allows the emulator outside production only with a demo- project and no credentials", () => {
      const config = expectConfig({
        DATABASE_URL: DB_URL,
        NODE_ENV: "development",
        FIREBASE_PROJECT_ID: "demo-massage",
        FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      });
      expect(config.firebase).toEqual({
        projectId: "demo-massage",
        credentials: { kind: "emulator", host: "127.0.0.1:9099" },
      });

      const realProject = expectErrors({
        DATABASE_URL: DB_URL,
        NODE_ENV: "test",
        FIREBASE_PROJECT_ID: "massage-staging",
        FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      });
      expect(realProject[0]).toMatch(/must start with "demo-"/);

      const withCredentials = expectErrors({
        DATABASE_URL: DB_URL,
        NODE_ENV: "test",
        FIREBASE_PROJECT_ID: "demo-massage",
        FIREBASE_CREDENTIALS: "application-default",
        FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
      });
      expect(withCredentials[0]).toMatch(/^FIREBASE_CREDENTIALS: must be none/);
    });

    it("rejects demo- projects without the emulator", () => {
      const errors = expectErrors({
        DATABASE_URL: DB_URL,
        FIREBASE_PROJECT_ID: "demo-massage",
        FIREBASE_CREDENTIALS: "application-default",
      });
      expect(errors[0]).toMatch(/exist only in the Auth Emulator/);
    });
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

  it("validates DATABASE_URL parameters against DATABASE_SSL_MODE without echoing values", () => {
    const base = "postgresql://user:url-secret-value@db.example.invalid/booking";

    expect(expectConfig({ DATABASE_URL: `${base}?sslmode=require` }).databaseUrl).toContain(
      "sslmode=require",
    );

    for (const [url, extra] of [
      [`${base}?sslmode=no-verify`, {}],
      [`${base}?sslrootcert=/tmp/ca.pem`, {}],
      [`${base}?channel_binding=require`, {}],
      [`${base}?sslmode=require`, { DATABASE_SSL_MODE: "disable" }],
    ] satisfies [string, Record<string, string>][]) {
      const errors = expectErrors({ DATABASE_URL: url, ...extra });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^DATABASE_URL: (parameter "(sslmode|channel_binding)"|contains an unsupported query parameter)/);
      expect(errors[0]).not.toContain("url-secret-value");
    }
  });
});
