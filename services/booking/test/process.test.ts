import { createServer, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  // Present in the environment but unused while marketing is disabled.
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

const isProcessAlive = (child: RunningChild): boolean => {
  const pid = child.process.pid;
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  it("starts without Brevo or Firebase config, serves health, has no /api routes and stops on SIGTERM", async () => {
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

  it.each([
    ["unencoded @ and ?", "postgresql://app:p@LEAKSECRET1?LEAKSECRET2@db.example.invalid/booking"],
    ["fragment", "postgresql://app:pw@db.example.invalid/booking#LEAKSECRET1"],
    ["broken percent-encoding", "postgresql://app:LEAKSECRET1%zz@db.example.invalid/booking"],
  ])("rejects a malformed DATABASE_URL (%s) without printing any part of it", async (_label, url) => {
    const child = startTsProcess("src/server.ts", { ...baseEnv, DATABASE_URL: url });

    const exit = await child.exited;

    expect(exit.code).toBe(1);
    expect(messages(child)).toContain("invalid configuration");
    // output() = stdout + stderr of the process.
    expect(child.output()).not.toContain("LEAKSECRET");
    expect(child.output()).not.toContain("db.example.invalid");
  });

  it("requires marketing settings when ENABLE_MARKETING_SUBSCRIPTION=true without printing secrets", async () => {
    const child = startTsProcess("src/server.ts", {
      ...baseEnv,
      ENABLE_MARKETING_SUBSCRIPTION: "true",
    });

    const exit = await child.exited;

    expect(exit.code).toBe(1);
    expect(child.output()).toContain("BREVO_API_KEY");
    expectNoSentinels(child.output());
  });

  it("refuses to start when REQUIRE_FIREBASE_AUTH=true but Firebase is not configured", async () => {
    const child = startTsProcess("src/server.ts", { ...baseEnv, REQUIRE_FIREBASE_AUTH: "true" });

    const exit = await child.exited;

    expect(exit.code).toBe(1);
    expect(child.output()).toContain("required when REQUIRE_FIREBASE_AUTH=true");
    expect(messages(child)).not.toContain("server listening");
    expectNoSentinels(child.output());
  });

  it("refuses to start in production with the Firebase Auth Emulator configured", async () => {
    const child = startTsProcess("src/server.ts", {
      ...baseEnv,
      FIREBASE_PROJECT_ID: "demo-massage",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    });

    const exit = await child.exited;

    expect(exit.code).toBe(1);
    expect(child.output()).toContain("FIREBASE_AUTH_EMULATOR_HOST");
    expect(messages(child)).not.toContain("server listening");
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
  type FixtureRun = { label: string; child: RunningChild; signals: NodeJS.Signals[] };
  let runs: FixtureRun[] = [];

  // On failure: the fixture's complete output (it receives no secrets), the
  // signals the test sent and how the process ended.
  beforeEach(({ onTestFailed }) => {
    runs = [];
    onTestFailed(() => {
      for (const run of runs) {
        const { exitCode, signalCode } = run.child.process;
        process.stderr.write(
          `\n----- shutdown fixture ${run.label}; signals sent: ${run.signals.join(", ") || "none"}; ` +
            `exitCode=${String(exitCode)} signalCode=${String(signalCode)} -----\n${run.child.output()}\n`,
        );
      }
    });
  });

  const startFixture = (
    mode: "complete" | "hang",
    shutdownTimeoutMs: number,
    cleanup: "resolve" | "hang" = "resolve",
  ): RunningChild => {
    const child = startTsProcess("test/fixtures/shutdown-fixture.ts", {
      FIXTURE_MODE: mode,
      FIXTURE_CLEANUP: cleanup,
      SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
    });
    runs.push({
      label: `(mode=${mode}, cleanup=${cleanup}, timeout=${String(shutdownTimeoutMs)} ms)`,
      child,
      signals: [],
    });
    return child;
  };

  const sendSignal = (child: RunningChild, signal: NodeJS.Signals) => {
    runs.find((run) => run.child === child)?.signals.push(signal);
    child.process.kill(signal);
  };

  it("lets an active request finish before the process exits", async () => {
    const child = startFixture("complete", 10_000);
    const port = await listeningPort(child);

    const response = fetch(`http://127.0.0.1:${port}/slow`).then(async (res) => ({
      status: res.status,
      body: await res.text(),
    }));
    await child.waitForLog(hasMessage("slow request started"));

    sendSignal(child, "SIGTERM");

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
    sendSignal(child, "SIGTERM");
    const exit = await child.exited;
    const elapsedMs = Date.now() - startedAt;

    expect(exit).toEqual({ code: 1, signal: null });
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(messages(child)).toContain("shutdown timed out");
    // The deadline expired during the HTTP phase, so cleanup was not reached.
    expect(messages(child)).not.toContain("fixture resources released");
    expect(await response).toEqual({ ok: false, status: 0 });
  });

  it("handles a repeated signal without restarting the shutdown", async () => {
    const child = startFixture("hang", 1_000);
    const port = await listeningPort(child);

    void fetch(`http://127.0.0.1:${port}/slow`).catch(() => undefined);
    await child.waitForLog(hasMessage("slow request started"));

    sendSignal(child, "SIGTERM");
    await child.waitForLog(hasMessage("shutdown started"));
    sendSignal(child, "SIGINT");
    await child.waitForLog(hasMessage("shutdown already in progress"));

    const exit = await child.exited;
    expect(exit.code).toBe(1);
    expect(messages(child).filter((message) => message === "shutdown started")).toHaveLength(1);
    expect(messages(child).filter((message) => message === "process exiting")).toHaveLength(1);
  });

  it("bounds the whole shutdown, including a cleanup that never finishes", async () => {
    const timeoutMs = 400;
    const child = startFixture("complete", timeoutMs, "hang");
    await listeningPort(child);

    const startedAt = Date.now();
    sendSignal(child, "SIGTERM");
    await child.waitForLog(hasMessage("fixture cleanup started and will never finish"));
    const exit = await child.exited;
    const elapsedMs = Date.now() - startedAt;

    expect(exit).toEqual({ code: 1, signal: null });
    expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs - 50);
    // Generous margin for process start-up noise, far below "never".
    expect(elapsedMs).toBeLessThan(timeoutMs + 3_000);
    expect(messages(child)).toContain("shutdown timed out");
    expect(isProcessAlive(child)).toBe(false);
  });
});

describe("logging right before process exit", () => {
  it("keeps the last lines complete and in order while the threadpool is busy", async () => {
    // One busy threadpool thread: an asynchronous stdout write would still be
    // queued when process.exit() flushes the later lines synchronously.
    const child = startTsProcess("test/fixtures/exit-log-order-fixture.ts", {
      UV_THREADPOOL_SIZE: "1",
    });

    expect(await child.exited).toEqual({ code: 0, signal: null });
    expect(messages(child)).toEqual(["first line", "second line", "process exiting"]);
  });
});
