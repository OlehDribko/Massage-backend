import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Disposable PostgreSQL containers for migration-runner tests. Each container
// gets a unique name and label, a published port on 127.0.0.1 only, random
// passwords, and is removed afterwards (`docker rm -f` of that name only).

export const POSTGRES_IMAGE =
  process.env.INTEGRATION_POSTGRES_IMAGE ?? "postgres:17.11-bookworm";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
export const CURRENT_INIT_DIR = `${repoRoot}docker/postgres/init`;
export const LEGACY_INIT_DIR = fileURLToPath(
  new URL("../../fixtures/legacy-postgres-init", import.meta.url),
);

const docker = (args: string[]): string => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `docker ${args[0] ?? ""} failed (Docker is required for integration tests): ${result.stderr || String(result.error)}`,
    );
  }
  return result.stdout.trim();
};

export type Role = "admin" | "migrator" | "app";

const ROLE_NAMES: Record<Role, string> = {
  admin: "booking_admin",
  migrator: "booking_migrator",
  app: "booking_app",
};

export type PostgresContainer = {
  name: string;
  port: number;
  url: (role: Role, password?: string) => string;
  /** Connects over TCP with password authentication (the published port). */
  connect: (role: Role, password?: string) => Promise<pg.Client>;
  query: (role: Role, sql: string) => Promise<pg.QueryResult>;
  stop: () => void;
};

export const assertDockerAvailable = (): void => {
  docker(["info", "--format", "{{.ServerVersion}}"]);
};

export const startPostgres = async (initDir: string): Promise<PostgresContainer> => {
  const name = `booking-it-${randomUUID().slice(0, 8)}`;
  const passwords: Record<Role, string> = {
    admin: randomUUID(),
    migrator: randomUUID(),
    app: randomUUID(),
  };

  docker([
    "run", "-d", "--rm",
    "--name", name,
    "--label", "massage-booking.integration-test=1",
    "-e", "POSTGRES_DB=booking",
    "-e", `POSTGRES_USER=${ROLE_NAMES.admin}`,
    "-e", `POSTGRES_PASSWORD=${passwords.admin}`,
    "-e", `BOOKING_MIGRATOR_PASSWORD=${passwords.migrator}`,
    "-e", `BOOKING_APP_PASSWORD=${passwords.app}`,
    "-v", `${initDir}:/docker-entrypoint-initdb.d:ro`,
    "-p", "127.0.0.1::5432",
    POSTGRES_IMAGE,
  ]);

  const mapping = docker(["port", name, "5432/tcp"]).split("\n")[0] ?? "";
  const port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));

  const url = (role: Role, password = passwords[role]) =>
    `postgresql://${ROLE_NAMES[role]}:${encodeURIComponent(password)}@127.0.0.1:${port}/booking`;

  const connect = async (role: Role, password = passwords[role]) => {
    const client = new pg.Client({
      host: "127.0.0.1",
      port,
      user: ROLE_NAMES[role],
      password,
      database: "booking",
      connectionTimeoutMillis: 5_000,
    });
    client.on("error", () => undefined);
    await client.connect();
    return client;
  };

  const query = async (role: Role, sql: string) => {
    const client = await connect(role);
    try {
      return await client.query(sql);
    } finally {
      await client.end();
    }
  };

  // The official image serves TCP only after init scripts have finished, so a
  // successful TCP login means initialisation is complete.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await query("admin", "SELECT 1");
      break;
    } catch (error) {
      if (Date.now() > deadline) {
        docker(["rm", "-f", name]);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return {
    name,
    port,
    url,
    connect,
    query,
    stop: () => {
      spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
    },
  };
};

/** Runs `sql` as `role`; resolves to the SQLSTATE on failure, "ok" otherwise. */
export const outcome = async (
  container: PostgresContainer,
  role: Role,
  sql: string,
): Promise<string> => {
  try {
    await container.query(role, sql);
    return "ok";
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    throw error;
  }
};
