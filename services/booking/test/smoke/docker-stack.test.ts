import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CURRENT_INIT_DIR,
  POSTGRES_IMAGE,
  assertDockerAvailable,
} from "../integration/helpers/postgres-container.js";

// Smoke test of the built images (not the TypeScript sources): PostgreSQL,
// the migrate image and the runtime image on one private Docker network, the
// same wiring as compose.yaml. Every resource gets a unique name and the label
// massage-booking.smoke-test=1 and is removed in afterAll, also on failure.
//
// The images must be built beforehand and passed by name:
//   BOOKING_RUNTIME_IMAGE=… BOOKING_MIGRATE_IMAGE=… npm run test:smoke

const LABEL = "massage-booking.smoke-test=1";
const RUNTIME_ROLE = "booking_app";

type CommandResult = { status: number | null; output: string };

const run = (args: string[], timeoutMs = 120_000): CommandResult => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs });
  if (result.error !== undefined) {
    throw new Error(`docker ${args[0] ?? ""} could not run: ${result.error.message}`);
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const docker = (args: string[], timeoutMs?: number): string => {
  const result = run(args, timeoutMs);
  if (result.status !== 0) {
    throw new Error(`docker ${args[0] ?? ""} failed (exit ${String(result.status)}): ${result.output}`);
  }
  return result.output.trim();
};

const requiredImage = (variable: string): string => {
  const value = process.env[variable];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${variable} must name a locally built image (see README, "CI")`);
  }
  return value;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const suffix = randomUUID().slice(0, 8);
const network = `booking-smoke-${suffix}`;
const postgres = `${network}-postgres`;
const api = `${network}-api`;
const passwords = { admin: randomUUID(), migrator: randomUUID(), app: randomUUID() };

let runtimeImage = "";
let migrateImage = "";
let apiPort = 0;
let migrateRuns = 0;
let failed = false;

const runMigrateImage = (): CommandResult => {
  migrateRuns += 1;
  return run(
    [
      "run", "--rm",
      "--name", `${network}-migrate-${String(migrateRuns)}`,
      "--label", LABEL,
      "--network", network,
      "-e", `MIGRATION_DATABASE_URL=postgresql://booking_migrator:${passwords.migrator}@postgres:5432/booking`,
      "-e", "MIGRATION_DATABASE_SSL_MODE=disable",
      "-e", `BOOKING_RUNTIME_ROLE=${RUNTIME_ROLE}`,
      migrateImage,
    ],
    300_000,
  );
};

/** psql inside a throwaway container on the stack network (TCP + scram-sha-256). */
const psqlAsApp = (password: string, sql: string): CommandResult =>
  run([
    "run", "--rm",
    "--label", LABEL,
    "--network", network,
    "-e", `PGPASSWORD=${password}`,
    POSTGRES_IMAGE,
    "psql", "-h", "postgres", "-U", RUNTIME_ROLE, "-d", "booking",
    "-v", "ON_ERROR_STOP=1", "-tAc", sql,
  ]);

const http = async (method: "GET" | "POST", path: string) => {
  const response = await fetch(`http://127.0.0.1:${String(apiPort)}${path}`, {
    method,
    signal: AbortSignal.timeout(5_000),
  });
  return response.status;
};

const printLogs = (container: string) => {
  const logs = run(["logs", "--tail", "200", container]);
  process.stderr.write(`\n----- docker logs ${container} -----\n${logs.output}\n`);
};

beforeAll(async () => {
  assertDockerAvailable();
  runtimeImage = requiredImage("BOOKING_RUNTIME_IMAGE");
  migrateImage = requiredImage("BOOKING_MIGRATE_IMAGE");

  docker(["network", "create", "--label", LABEL, network]);
  docker([
    "run", "-d",
    "--name", postgres,
    "--label", LABEL,
    "--network", network,
    "--network-alias", "postgres",
    "-e", "POSTGRES_DB=booking",
    "-e", "POSTGRES_USER=booking_admin",
    "-e", `POSTGRES_PASSWORD=${passwords.admin}`,
    "-e", `BOOKING_MIGRATOR_PASSWORD=${passwords.migrator}`,
    "-e", `BOOKING_APP_PASSWORD=${passwords.app}`,
    "-v", `${CURRENT_INIT_DIR}:/docker-entrypoint-initdb.d:ro`,
    POSTGRES_IMAGE,
  ], 300_000);

  // During initialisation the server listens on the Unix socket only, so a
  // TCP answer means the init scripts have finished.
  const deadline = Date.now() + 90_000;
  while (run(["exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "booking_admin", "-d", "booking"]).status !== 0) {
    if (Date.now() > deadline) {
      throw new Error("PostgreSQL did not become ready in 90 s");
    }
    await sleep(500);
  }
});

beforeEach(({ onTestFailed }) => {
  onTestFailed(() => {
    failed = true;
  });
});

afterAll(() => {
  if (failed) {
    printLogs(postgres);
    printLogs(api);
  }
  run(["rm", "-f", api, postgres]);
  run(["network", "rm", network]);
});

describe("docker images: migrate + runtime against PostgreSQL", () => {
  it("migrate image applies all migrations and grants runtime DML", () => {
    const result = runMigrateImage();

    expect(result.output).toContain("All migrations have been successfully applied.");
    expect(result.output).toContain("runtime privileges granted on business tables");
    expect(result.status).toBe(0);
  });

  it("second migrate run is a no-op", () => {
    const result = runMigrateImage();

    expect(result.output).toContain("No pending migrations to apply.");
    expect(result.status).toBe(0);
  });

  it("runtime role: DML on business tables, no access to _prisma_migrations, wrong password rejected", () => {
    expect(psqlAsApp(passwords.app, `SELECT count(*) FROM "User"`)).toMatchObject({ status: 0 });

    const history = psqlAsApp(passwords.app, "SELECT count(*) FROM _prisma_migrations");
    expect(history.status).not.toBe(0);
    expect(history.output).toContain("permission denied");

    const wrong = psqlAsApp("wrong-password", "SELECT 1");
    expect(wrong.status).not.toBe(0);
    expect(wrong.output).toContain("password authentication failed");
  });

  it("runtime image serves live/ready, hides legacy routes and runs as non-root", async () => {
    docker([
      "run", "-d",
      "--name", api,
      "--label", LABEL,
      "--network", network,
      "--init",
      "-p", "127.0.0.1::3001",
      "-e", "NODE_ENV=production",
      "-e", "PORT=3001",
      "-e", "LOG_LEVEL=info",
      "-e", "APP_VERSION=smoke",
      "-e", `DATABASE_URL=postgresql://${RUNTIME_ROLE}:${passwords.app}@postgres:5432/booking`,
      "-e", "DATABASE_SSL_MODE=disable",
      "-e", "ENABLE_LEGACY_USER_ROUTES=false",
      "-e", "SHUTDOWN_TIMEOUT_MS=10000",
      runtimeImage,
    ]);
    const mapping = docker(["port", api, "3001/tcp"]).split("\n")[0] ?? "";
    apiPort = Number(mapping.slice(mapping.lastIndexOf(":") + 1));

    const deadline = Date.now() + 60_000;
    for (;;) {
      const status = await http("GET", "/health/live").catch(() => 0);
      if (status === 200) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("runtime did not answer /health/live in 60 s");
      }
      await sleep(500);
    }

    expect(await http("GET", "/health/live")).toBe(200);
    expect(await http("GET", "/health/ready")).toBe(200);
    expect(await http("GET", "/api/users")).toBe(404);
    expect(await http("POST", "/api/users/subscribe")).toBe(404);

    expect(docker(["inspect", "--format", "{{.Config.User}}", api])).toBe("node");
    expect(docker(["exec", api, "id", "-u"])).not.toBe("0");
  });

  it("runtime stops cleanly on SIGTERM", () => {
    docker(["stop", "--time", "20", api], 60_000);

    expect(docker(["inspect", "--format", "{{.State.ExitCode}}", api])).toBe("0");
  });
});
