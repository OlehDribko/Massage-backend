import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { createReadinessProbe, type ReadinessOutcome } from "../src/http/health.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { createCapturingLogger } from "./helpers/logs.js";

const SENSITIVE = [
  "SENTINEL_QUERY_TOKEN",
  "SENTINEL_AUTH",
  "SENTINEL_COOKIE",
  "SENTINEL_PASSWORD",
  "SENTINEL_INTERNAL",
  "SENTINEL_DB_PASSWORD",
];

const expectNoSensitive = (text: string) => {
  for (const value of SENSITIVE) {
    expect(text).not.toContain(value);
  }
};

const bodyOf = (response: request.Response): unknown => {
  const body: unknown = response.body;
  return body;
};

const buildApp = (overrides: Partial<AppDeps> = {}) => {
  const logs = createCapturingLogger();
  const app = createApp({
    logger: logs.logger,
    isShuttingDown: () => false,
    probeReadiness: () => Promise.resolve("ready"),
    appVersion: undefined,
    corsOrigin: undefined,
    legacyUserRouter: undefined,
    ...overrides,
  });
  return { app, logs };
};

const countingCheck = (behaviour: () => Promise<unknown>) => {
  let calls = 0;
  return {
    check: () => {
      calls += 1;
      return behaviour();
    },
    calls: () => calls,
  };
};

describe("health checks", () => {
  it("live returns 200 without touching the database", async () => {
    const db = countingCheck(() => Promise.resolve());
    const { app } = buildApp({ probeReadiness: createReadinessProbe(db.check, 100) });

    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({ status: "ok" });
    expect(db.calls()).toBe(0);
  });

  it("ready returns 200 and the version when the database answers", async () => {
    const db = countingCheck(() => Promise.resolve([{ "?column?": 1 }]));
    const { app } = buildApp({
      probeReadiness: createReadinessProbe(db.check, 100),
      appVersion: "1.2.3",
    });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toEqual({ status: "ready", version: "1.2.3" });
    expect(db.calls()).toBe(1);
  });

  it("ready returns 503 without internal details when the database fails", async () => {
    const db = countingCheck(() =>
      Promise.reject(
        new Error("connect failed postgresql://u:SENTINEL_DB_PASSWORD@db.internal/x"),
      ),
    );
    const { app, logs } = buildApp({ probeReadiness: createReadinessProbe(db.check, 100) });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(bodyOf(response)).toEqual({
      status: "unavailable",
      reason: "database_unavailable",
    });
    expectNoSensitive(response.text + logs.raw());
  });

  it("ready returns 503 on timeout and does not stack concurrent hung checks", async () => {
    const db = countingCheck(() => new Promise<never>(() => undefined));
    const { app } = buildApp({ probeReadiness: createReadinessProbe(db.check, 30) });

    const [first, second] = await Promise.all([
      request(app).get("/health/ready"),
      request(app).get("/health/ready"),
    ]);
    const third = await request(app).get("/health/ready");

    expect([first.status, second.status, third.status]).toEqual([503, 503, 503]);
    expect(db.calls()).toBe(1);
  });

  it("ready returns 503 while shutting down without checking the database", async () => {
    const db = countingCheck(() => Promise.resolve());
    const { app } = buildApp({
      isShuttingDown: () => true,
      probeReadiness: createReadinessProbe(db.check, 100),
    });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(bodyOf(response)).toEqual({ status: "unavailable", reason: "shutting_down" });
    expect(db.calls()).toBe(0);
  });

  it("does not log successful health checks at info level", async () => {
    const { app, logs } = buildApp();

    await request(app).get("/health/live");

    const requestLogs = logs.entries().filter((entry) => entry.msg === "request completed");
    expect(requestLogs.map((entry) => entry.level)).toEqual(["debug"]);
  });
});

describe("readiness probe", () => {
  it.each<[string, ReadinessOutcome, () => Promise<unknown>]>([
    ["resolves", "ready", () => Promise.resolve()],
    ["rejects", "unavailable", () => Promise.reject(new Error("down"))],
    [
      "throws synchronously",
      "unavailable",
      () => {
        throw new Error("sync");
      },
    ],
    ["hangs", "timeout", () => new Promise<never>(() => undefined)],
  ])("check that %s → %s", async (_name, expected, check) => {
    await expect(createReadinessProbe(check, 20)()).resolves.toBe(expected);
  });
});

describe("HTTP errors", () => {
  it("returns 400 for malformed JSON", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/api/anything")
      .set("Content-Type", "application/json")
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(bodyOf(response)).toEqual({
      message: "Malformed JSON request body",
      code: "INVALID_JSON",
    });
  });

  it("returns 413 for a body above the limit", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/api/anything")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ padding: "x".repeat(20 * 1024) }));

    expect(response.status).toBe(413);
    expect(bodyOf(response)).toEqual({
      message: "Request body too large",
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("returns a JSON 404 for unknown routes, including legacy routes when disabled", async () => {
    const { app } = buildApp();

    for (const path of ["/nope", "/api/users", "/api/users/subscribe", "/api"]) {
      const response = await request(app).post(path).send({ email: "a@example.invalid" });
      expect(response.status).toBe(404);
      expect(bodyOf(response)).toEqual({ message: "Not found", code: "NOT_FOUND" });
    }
  });

  it("returns a neutral 500 and logs only safe error details", async () => {
    const router = Router();
    router.post("/explode", () => {
      throw new Error("SENTINEL_INTERNAL postgresql://u:SENTINEL_DB_PASSWORD@db/x");
    });
    const { app, logs } = buildApp({ legacyUserRouter: router });

    const response = await request(app).post("/api/users/explode").send({});

    expect(response.status).toBe(500);
    expect(bodyOf(response)).toEqual({ message: "internal server error" });
    expectNoSensitive(response.text + logs.raw());

    const errorLog = logs.entries().find((entry) => entry.msg === "unhandled error");
    expect(errorLog).toMatchObject({ level: "error", error: { type: "Error" } });
  });

  it("keeps the AppError response format", async () => {
    const router = Router();
    router.post("/conflict", () => {
      throw new AppError(409, "User with this email already exists", {
        code: "CONFLICT",
        details: { retryAfterSeconds: 30 },
      });
    });
    const { app } = buildApp({ legacyUserRouter: router });

    const response = await request(app).post("/api/users/conflict").send({});

    expect(response.status).toBe(409);
    expect(response.get("Retry-After")).toBe("30");
    expect(bodyOf(response)).toEqual({
      message: "User with this email already exists",
      code: "CONFLICT",
      retryAfterSeconds: 30,
    });
  });

  it("does not trust an arbitrary status on unknown errors", async () => {
    const router = Router();
    router.post("/fake-status", () => {
      throw Object.assign(new Error("SENTINEL_INTERNAL"), { status: 418, expose: true });
    });
    const { app, logs } = buildApp({ legacyUserRouter: router });

    const response = await request(app).post("/api/users/fake-status").send({});

    expect(response.status).toBe(500);
    expectNoSensitive(response.text + logs.raw());
  });
});

describe("request logging", () => {
  it("logs method, path, status, duration and request id without sensitive data", async () => {
    const { app, logs } = buildApp();

    const response = await request(app)
      .post("/api/users/subscribe?token=SENTINEL_QUERY_TOKEN")
      .set("Authorization", "Bearer SENTINEL_AUTH")
      .set("Cookie", "session=SENTINEL_COOKIE")
      .set("X-Request-Id", "client-supplied-id")
      .send({ email: "user@example.invalid", password: "SENTINEL_PASSWORD" });

    const requestId = response.get("X-Request-Id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestId).not.toBe("client-supplied-id");

    const entry = logs.entries().find((log) => log.msg === "request completed");
    expect(entry).toMatchObject({
      level: "info",
      requestId,
      method: "POST",
      path: "/api/users/subscribe",
      status: 404,
    });
    expect(typeof entry?.durationMs).toBe("number");

    const raw = logs.raw();
    expectNoSensitive(raw);
    expect(raw).not.toContain("user@example.invalid");
    expect(raw).not.toContain("client-supplied-id");
  });
});
