// Migration task: privilege repair → `prisma migrate deploy` → runtime grants.
// Used by the Docker `migrate` target and `npm run migrate:deploy`.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { createLogger, describeError } from "../logging/logger.js";
import { parseDatabaseUrl } from "../shared/database/database-url.js";
import { buildPoolConfig } from "../shared/database/pool-config.js";
import { grantRuntimePrivileges, prepareRuntimePrivileges } from "./privileges.js";

const logger = createLogger({ level: "info" });

const envSchema = z.object({
  MIGRATION_DATABASE_URL: z.string().trim().min(1, "is required"),
  MIGRATION_DATABASE_SSL_MODE: z
    .enum(["verify-full", "disable"], { error: "must be verify-full or disable" })
    .default("verify-full"),
  // Unquoted PostgreSQL identifier; it is additionally quoted with %I in SQL.
  BOOKING_RUNTIME_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/, "must be a lowercase PostgreSQL role name"),
});

// Optional `--config <path>` is passed to Prisma (used by test fixtures).
const argsSchema = z.union([
  z.tuple([]),
  z.tuple([z.literal("--config"), z.string().min(1)]),
]);

const serviceDir = fileURLToPath(new URL("../..", import.meta.url));
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");

const withClient = async (
  config: pg.ClientConfig,
  work: (client: pg.Client) => Promise<void>,
): Promise<void> => {
  const client = new pg.Client(config);
  client.on("error", () => undefined);
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
};

const runPrismaDeploy = (args: string[]): Promise<number> =>
  new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [prismaCli, "migrate", "deploy", ...args], {
      cwd: serviceDir,
      stdio: "inherit",
      env: { ...process.env, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGTERM", forward);
    process.on("SIGINT", forward);
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => {
      process.off("SIGTERM", forward);
      process.off("SIGINT", forward);
      resolve(code ?? (signal !== null ? 1 : 0));
    });
  });

const main = async (): Promise<number> => {
  const env = envSchema.safeParse(process.env);
  const args = argsSchema.safeParse(process.argv.slice(2));
  if (!env.success || !args.success) {
    // Names of variables and rules only, never values.
    const errors = [
      ...(env.success ? [] : env.error.issues),
      ...(args.success ? [] : args.error.issues),
    ].map((issue) => `${issue.path.map(String).join(".") || "arguments"}: ${issue.message}`);
    logger.fatal({ errors }, "invalid migration configuration");
    return 1;
  }

  const { MIGRATION_DATABASE_URL: url, MIGRATION_DATABASE_SSL_MODE: sslMode } = env.data;
  const runtimeRole = env.data.BOOKING_RUNTIME_ROLE;

  const parsedUrl = parseDatabaseUrl(url, sslMode);
  if (!parsedUrl.ok) {
    logger.fatal({ errors: [`MIGRATION_DATABASE_URL: ${parsedUrl.error}`] }, "invalid migration configuration");
    return 1;
  }

  const clientConfig = buildPoolConfig({
    url,
    sslMode,
    poolMax: 1,
    connectTimeoutMs: 10_000,
    queryTimeoutMs: 60_000,
  });

  try {
    await withClient(clientConfig, (client) => prepareRuntimePrivileges(client, runtimeRole));
    logger.info({ runtimeRole }, "runtime privileges prepared (closed by default)");
  } catch (error) {
    logger.fatal({ error: describeError(error), runtimeRole }, "privilege preparation failed; migrations not started");
    return 1;
  }

  const deployCode = await runPrismaDeploy(args.data);
  if (deployCode !== 0) {
    // Nothing else to do: new tables and _prisma_migrations stay closed.
    logger.fatal({ exitCode: deployCode }, "prisma migrate deploy failed; runtime grants not applied");
    return deployCode;
  }

  try {
    await withClient(clientConfig, (client) => grantRuntimePrivileges(client, runtimeRole));
    logger.info({ runtimeRole }, "runtime privileges granted on business tables");
  } catch (error) {
    logger.fatal({ error: describeError(error), runtimeRole }, "granting runtime privileges failed");
    return 1;
  }

  return 0;
};

process.exitCode = await main();
