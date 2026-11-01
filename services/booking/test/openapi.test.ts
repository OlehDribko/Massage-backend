import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../src/bootstrap.js";
import { loadConfig, type AppConfig } from "../src/config/config.js";
import type { IdentityProvider } from "../src/modules/auth/identity.js";
import type { MarketingMailer } from "../src/modules/email/service/email.service.js";
import { buildOpenApiDocument } from "../src/openapi/document.js";
import { createDatabase, type Database } from "../src/shared/database/database.js";
import { createCapturingLogger } from "./helpers/logs.js";

// The OpenAPI document and Swagger UI: valid, complete against the routes of
// the code, correct about which operations need a token, switchable, and
// served without touching the database, Firebase, Brevo or the network.

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const DUMMY_DATABASE_URL = "postgresql://user:pass@127.0.0.1:5/booking";
const real = createDatabase(
  { url: DUMMY_DATABASE_URL, sslMode: "disable", poolMax: 1, connectTimeoutMs: 1_000, queryTimeoutMs: 1_000 },
  createCapturingLogger().logger,
);

// Everything external is counted: database (any use of the Prisma client or
// the readiness ping), Firebase (identity provider), Brevo (mailer), network.
const calls = { prisma: 0, ping: 0, identity: 0, mailer: 0, fetch: 0 };
const resetCalls = () => {
  calls.prisma = 0;
  calls.ping = 0;
  calls.identity = 0;
  calls.mailer = 0;
  calls.fetch = 0;
};
const database: Database = {
  prisma: new Proxy(real.prisma, {
    get: (target, property, receiver) => {
      calls.prisma += 1;
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  }),
  ping: (timeoutMs) => {
    calls.ping += 1;
    return real.ping(timeoutMs);
  },
  close: () => real.close(),
};
const identityProvider: IdentityProvider = {
  verifyIdToken: () => {
    calls.identity += 1;
    return Promise.resolve({ ok: false, reason: "invalid" });
  },
  revokeAllSessions: () => {
    calls.identity += 1;
    return Promise.resolve("unavailable");
  },
};
const marketingMailer: MarketingMailer = {
  sendConfirmationRequest: () => {
    calls.mailer += 1;
    return Promise.resolve({ kind: "accepted" });
  },
  sendSubscriptionConfirmed: () => {
    calls.mailer += 1;
    return Promise.resolve({ kind: "accepted" });
  },
};

const FULL_ENV = {
  FIREBASE_PROJECT_ID: "massage-staging",
  FIREBASE_CREDENTIALS: "application-default",
  ENABLE_MARKETING_SUBSCRIPTION: "true",
  BREVO_API_KEY: "dummy-brevo-key",
  EMAIL_FROM_NAME: "Test",
  EMAIL_FROM_EMAIL: "sender@example.invalid",
  ACTION_TOKEN_SECRET: "dummy-action-secret-0123456789abcdef",
  FRONTEND_URL: "http://localhost:5173",
};

const configFrom = (env: Record<string, string>): AppConfig => {
  const result = loadConfig({ DATABASE_URL: DUMMY_DATABASE_URL, DATABASE_SSL_MODE: "disable", ...env });
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result.config;
};

const appWith = (env: Record<string, string>) =>
  createApplication({
    config: configFrom(env),
    logger: createCapturingLogger().logger,
    database,
    isShuttingDown: () => false,
    overrides: { identityProvider, marketingMailer },
  });

type Method = "get" | "post" | "put" | "patch" | "delete";
const METHODS: Method[] = ["get", "post", "put", "patch", "delete"];

const documentedOperations = () => {
  const document = buildOpenApiDocument();
  const operations: { method: Method; path: string; security: Record<string, string[]>[] }[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (operation !== undefined) {
        operations.push({ method, path, security: operation.security });
      }
    }
  }
  return operations;
};

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? (entry === "generated" ? [] : filesUnder(full)) : full.endsWith(".ts") ? [full] : [];
  });

/**
 * Routes of the code, read from the source: every exported router factory
 * with the prefix bootstrap/app mount it under. A new factory without a
 * prefix here fails the test, so new routes cannot stay undocumented.
 */
const MOUNTS: Record<string, { prefix: string; mountedIn: string; mount: string } | "not-business-api"> = {
  createHealthRouter: { prefix: "/health", mountedIn: "app.ts", mount: `"/health",\n    createHealthRouter(` },
  createPublicCatalogRouter: { prefix: "/api/services", mountedIn: "bootstrap.ts", mount: `api.use("/services", createPublicCatalogRouter(` },
  createPublicAvailabilityRouter: { prefix: "/api/services/{serviceId}/availability", mountedIn: "bootstrap.ts", mount: `"/services/:serviceId/availability",\n    createPublicAvailabilityRouter(` },
  createProfileRouter: { prefix: "/api/me", mountedIn: "bootstrap.ts", mount: `"/me",\n      createProfileRouter(` },
  createMarketingRouter: { prefix: "/api/marketing", mountedIn: "bootstrap.ts", mount: `api.use("/marketing", createMarketingRouter(` },
  createClientBookingRouter: { prefix: "/api/bookings", mountedIn: "bootstrap.ts", mount: `api.use("/bookings", authenticate, createClientBookingRouter(` },
  createAdminScheduleRouter: { prefix: "/api/admin/schedule", mountedIn: "bootstrap.ts", mount: `"/schedule",\n      createAdminScheduleRouter(` },
  createAdminBookingRouter: { prefix: "/api/admin/bookings", mountedIn: "bootstrap.ts", mount: `admin.use("/bookings", createAdminBookingRouter(` },
  createDocsRouter: "not-business-api",
};

const routesOfCode = () => {
  const routes: string[] = [];
  const factories: string[] = [];
  for (const file of filesUnder(SRC)) {
    const source = readFileSync(file, "utf8");
    const blocks = source.split(/(?=export const create\w+Router\b)/);
    for (const block of blocks) {
      const name = /^export const (create\w+Router)\b/.exec(block)?.[1];
      if (name === undefined) {
        continue;
      }
      factories.push(name);
      const mount = MOUNTS[name];
      if (mount === undefined) {
        throw new Error(`router factory ${name} has no documented mount prefix in this test`);
      }
      if (mount === "not-business-api") {
        continue;
      }
      expect(readFileSync(join(SRC, mount.mountedIn), "utf8")).toContain(mount.mount);
      for (const match of block.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
        const [, method = "", path = ""] = match;
        const suffix = path === "/" ? "" : path.replace(/:(\w+)/g, "{$1}");
        routes.push(`${method.toUpperCase()} ${mount.prefix}${suffix}`);
      }
    }
  }
  return { routes: routes.sort(), factories };
};

const concrete = (path: string) =>
  path
    .replace("{serviceId}", "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f")
    .replace("{bookingId}", "8f0c2b1e-4a5d-4c6e-9f7a-1b2c3d4e5f60")
    .replace("{date}", "2027-03-08");

beforeEach(() => {
  resetCalls();
  vi.stubGlobal("fetch", () => {
    calls.fetch += 1;
    return Promise.reject(new Error("no network in this test"));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await real.close();
});

describe("OpenAPI document", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    const document = buildOpenApiDocument();
    expect(document.openapi).toBe("3.1.0");
    // Validated from a file, exactly as served (JSON).
    const dir = mkdtempSync(join(tmpdir(), "openapi-"));
    try {
      const file = join(dir, "openapi.json");
      writeFileSync(file, JSON.stringify(document));
      await expect(SwaggerParser.validate(file)).resolves.toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("documents exactly the routes of the code, nothing more (no /api/admin/services, no sign-in routes)", () => {
    const { routes, factories } = routesOfCode();
    expect(factories.sort()).toEqual(Object.keys(MOUNTS).sort());
    const documented = documentedOperations()
      .map((operation) => `${operation.method.toUpperCase()} ${operation.path}`)
      .sort();
    expect(documented).toEqual(routes);
    expect(documented).toHaveLength(27);
    const text = JSON.stringify(buildOpenApiDocument());
    expect(text).not.toContain("/api/admin/services");
    expect(Object.keys(buildOpenApiDocument().paths).some((path) => /login|signin|sign-in|signup|password|register/i.test(path))).toBe(false);
  });

  it("every operation states its access; protected ones reject requests without a token (401), public ones never ask for one", async () => {
    const app = appWith(FULL_ENV);
    const operations = documentedOperations();
    const publicOnes: string[] = [];
    for (const operation of operations) {
      const name = `${operation.method.toUpperCase()} ${operation.path}`;
      const response = await request(app)[operation.method](concrete(operation.path)).send({});
      if (operation.security.length === 0) {
        publicOnes.push(name);
        expect(response.status, name).not.toBe(401);
        expect(response.body, name).not.toEqual({ message: "Not found", code: "NOT_FOUND" });
      } else {
        expect(operation.security, name).toEqual([{ firebaseIdToken: [] }]);
        expect(response.status, name).toBe(401);
        expect(response.body, name).toMatchObject({ code: "AUTH_REQUIRED" });
      }
    }
    expect(publicOnes.sort()).toEqual(
      [
        "GET /health/live",
        "GET /health/ready",
        "GET /api/services",
        "GET /api/services/{serviceId}",
        "GET /api/services/{serviceId}/availability",
        "POST /api/marketing/subscriptions",
        "POST /api/marketing/subscriptions/confirm",
        "POST /api/marketing/subscriptions/unsubscribe",
      ].sort(),
    );
  });

  it("has a Bearer scheme for the Firebase ID token, relative server URL, no secrets or real tokens", () => {
    const document = buildOpenApiDocument();
    expect(document.components.securitySchemes).toMatchObject({ firebaseIdToken: { type: "http", scheme: "bearer" } });
    expect(document.servers.map((server) => server.url)).toEqual(["/"]);
    const text = JSON.stringify(document);
    expect(text).not.toMatch(/xkeysib|eyJ[A-Za-z0-9_-]{10,}|staging|execute-api|amazonaws|massage-fr/);
    for (const email of text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []) {
      expect(email).toMatch(/@example\.invalid$/);
    }
  });
});

describe("documentation routes", () => {
  it("are absent by default and when ENABLE_API_DOCS=false", async () => {
    for (const env of [FULL_ENV, { ...FULL_ENV, ENABLE_API_DOCS: "false" }]) {
      const app = appWith(env);
      for (const path of ["/openapi.json", "/docs", "/docs/", "/docs/swagger-ui-bundle.js", "/docs/swagger-ui.css", "/docs/swagger-init.js"]) {
        const response = await request(app).get(path);
        expect(response.status, path).toBe(404);
      }
    }
  });

  it("with ENABLE_API_DOCS=true: the document, Swagger UI and its assets, without any database, Firebase, Brevo or network access", async () => {
    const app = appWith({ ...FULL_ENV, ENABLE_API_DOCS: "true" });
    resetCalls();

    const spec = await request(app).get("/openapi.json").expect(200);
    expect(spec.headers["content-type"]).toMatch(/application\/json/);
    const expected: unknown = JSON.parse(JSON.stringify(buildOpenApiDocument()));
    expect(spec.body).toEqual(expected);

    await request(app).get("/docs").expect(301).expect("Location", "/docs/");
    const page = await request(app).get("/docs/").expect(200);
    expect(page.text).toContain('<script src="/docs/swagger-ui-bundle.js"></script>');
    const init = await request(app).get("/docs/swagger-init.js").expect(200);
    expect(init.text).toContain('url: "/openapi.json"');
    expect(init.text).toContain("persistAuthorization: false");
    expect(init.text).toContain('validatorUrl: "none"');
    expect((await request(app).get("/docs/swagger-ui-bundle.js").expect(200)).headers["content-type"]).toMatch(/javascript/);
    expect((await request(app).get("/docs/swagger-ui.css").expect(200)).headers["content-type"]).toMatch(/css/);
    // The package's demo files are not served.
    await request(app).get("/docs/index.html").expect(404);
    await request(app).get("/docs/swagger-initializer.js").expect(404);

    expect(calls).toEqual({ prisma: 0, ping: 0, identity: 0, mailer: 0, fetch: 0 });
  });
});
