import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  getFreePort,
  hasMessage,
  killRunningChildren,
  startTsProcess,
  type RunningChild,
} from "./helpers/child-process.js";

const SENTINELS = {
  dbPassword: "SENTINEL_DB_PASSWORD",
  actionSecret: "SENTINEL_ACTION_SECRET",
};

const baseEnv = {
  NODE_ENV: "production",
  LOG_LEVEL: "info",
  DATABASE_URL: `postgresql://user:${SENTINELS.dbPassword}@127.0.0.1:5/booking`,
  // Present in the environment but unused while legacy routes are disabled.
  ACTION_TOKEN_SECRET: SENTINELS.actionSecret,
};

const listeningPort = async (child: RunningChild): Promise<number> => {
  const entry = await child.waitForLog(hasMessage("server listening"));
  const port = entry.port;
  if (typeof port !== "number") {
    throw new Error("listening log without a numeric port");
  }
  return port;
};

const messages = (child: RunningChild): (string | undefined)[] =>
  child.entries().map((entry) => entry.msg);

const expectNoSentinels = (output: string) => {
  for (const value of Object.values(SENTINELS)) {
    expect(output).not.toContain(value);
  }
};

let blocker: Server | undefined;

afterEach(async () => {
  await killRunningChildren();
  if (blocker !== undefined) {
    const server = blocker;
    blocker = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("entry point (src/server.ts)", () => {
  it("starts without Brevo config, serves health, hides legacy routes and stops on SIGTERM", async () => {
    const port = await getFreePort();
    const child = startTsProcess("src/server.ts", { ...baseEnv, PORT: String(port) });

    expect(await listeningPort(child)).toBe(port);

    const live = await fetch(`http://127.0.0.1:${port}/health/live`);
    expect(live.status).toBe(200);

    const legacy = await fetch(`http://127.0.0.1:${port}/api/users/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@example.invalid" }),
    });
    expect(legacy.status).toBe(404);

    child.process.kill("SIGTERM");
    const exit = await child.exited;

    expect(exit).toEqual({ code: 0, signal: null });
    expect(messages(child)).toEqual(
      expect.arrayContaining(["shutdown started", "HTTP server closed", "process exiting"]),
    );
    expectNoSentinels(child.output());
  });

  it("exits with code 1 and a safe message on invalid configuration", async () => {
    const child = startTsProcess("src/server.ts", { ...baseEnv, PORT: "not-a-port" });

    const exit = await child.exited;

    expect(exit.code).toBe(1);
    const entry = child.entries().find((log) => log.msg === "invalid configuration");
    expect(JSON.stringify(entry?.errors)).toContain("PORT");
    expect(messages(child)).not.toContain("server listening");
    expectNoSentinels(child.output());
  });

  it("requires legacy settings when ENABLE_LEGACY_USER_ROUTES=true without printing secrets", async () => {
    const child = startTsProcess("src/server.ts", {
      ...baseEnv,
      ENABLE_LEGACY_USER_ROUTES: "true",
    });

    const exit = await child.exited;

    expect(exit.code).toBe(1);
    expect(child.output()).toContain("BREVO_API_KEY");
    expectNoSentinels(child.output());
  });

  it("exits with code 1 when the port is already in use", async () => {
    const port = await getFreePort();
    const occupied = createServer();
    blocker = occupied;
    await new Promise<void>((resolve) => occupied.listen(port, "0.0.0.0", () => resolve()));

    const child = startTsProcess("src/server.ts", { ...baseEnv, PORT: String(port) });
    const exit = await child.exited;

    expect(exit.code).toBe(1);
    const entry = child.entries().find((log) => log.msg === "failed to start HTTP server");
    expect(entry).toMatchObject({ level: "fatal", error: { code: "EADDRINUSE" } });
    expectNoSentinels(child.output());
  });
});

describe("graceful shutdown (fixture)", () => {
  const startFixture = (mode: "complete" | "hang", shutdownTimeoutMs: number) =>
    startTsProcess("test/fixtures/shutdown-fixture.ts", {
      FIXTURE_MODE: mode,
      SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
    });

  it("lets an active request finish before the process exits", async () => {
    const child = startFixture("complete", 10_000);
    const port = await listeningPort(child);

    const response = fetch(`http://127.0.0.1:${port}/slow`).then(async (res) => ({
      status: res.status,
      body: await res.text(),
    }));
    await child.waitForLog(hasMessage("slow request started"));

    child.process.kill("SIGTERM");

    expect(await response).toEqual({ status: 200, body: '{"completed":true}' });
    expect(await child.exited).toEqual({ code: 0, signal: null });

    const order = messages(child);
    const indexOf = (message: string) => order.indexOf(message);
    expect(indexOf("shutdown started")).toBeGreaterThan(-1);
    expect(indexOf("shutdown started")).toBeLessThan(indexOf("slow request finished"));
    expect(indexOf("slow request finished")).toBeLessThan(indexOf("HTTP server closed"));
    expect(indexOf("HTTP server closed")).toBeLessThan(indexOf("fixture resources released"));
    expect(indexOf("fixture resources released")).toBeLessThan(indexOf("process exiting"));
  });

  it("forces exit with code 1 when requests outlive the shutdown timeout", async () => {
    const timeoutMs = 300;
    const child = startFixture("hang", timeoutMs);
    const port = await listeningPort(child);

    const response = fetch(`http://127.0.0.1:${port}/slow`).then(
      (res) => ({ ok: true, status: res.status }),
      () => ({ ok: false, status: 0 }),
    );
    await child.waitForLog(hasMessage("slow request started"));

    const startedAt = Date.now();
    child.process.kill("SIGTERM");
    const exit = await child.exited;
    const elapsedMs = Date.now() - startedAt;

    expect(exit).toEqual({ code: 1, signal: null });
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(messages(child)).toContain("shutdown timed out; closing remaining connections");
    expect(messages(child)).toContain("fixture resources released");
    expect(await response).toEqual({ ok: false, status: 0 });
  });

  it("handles a repeated signal without restarting the shutdown", async () => {
    const child = startFixture("hang", 1_000);
    const port = await listeningPort(child);

    void fetch(`http://127.0.0.1:${port}/slow`).catch(() => undefined);
    await child.waitForLog(hasMessage("slow request started"));

    child.process.kill("SIGTERM");
    await child.waitForLog(hasMessage("shutdown started"));
    child.process.kill("SIGINT");
    await child.waitForLog(hasMessage("shutdown already in progress"));

    const exit = await child.exited;
    expect(exit.code).toBe(1);
    expect(messages(child).filter((message) => message === "shutdown started")).toHaveLength(1);
    expect(messages(child).filter((message) => message === "process exiting")).toHaveLength(1);
  });
});
