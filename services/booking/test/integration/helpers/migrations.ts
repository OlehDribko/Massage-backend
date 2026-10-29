import { startTsProcess } from "../../helpers/child-process.js";
import type { PostgresContainer } from "./postgres-container.js";

import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("../../../prisma/migrations", import.meta.url));
const schemaFile = fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url));

/**
 * Runs the real migration runner (privileges + prisma migrate deploy + grants).
 * With `upTo`, only migrations up to and including that one are applied
 * (to create data of an older schema first).
 */
export const runMigrations = async (container: PostgresContainer, runtimeRole = "booking_app", upTo?: string) => {
  let args: string[] = [];
  let workDir: string | undefined;
  if (upTo !== undefined) {
    workDir = mkdtempSync(join(tmpdir(), "booking-migrations-"));
    for (const entry of readdirSync(migrationsDir)) {
      if (entry === "migration_lock.toml" || entry <= upTo) {
        cpSync(join(migrationsDir, entry), join(workDir, "migrations", entry), { recursive: true });
      }
    }
    cpSync(schemaFile, join(workDir, "schema.prisma"));
    writeFileSync(
      join(workDir, "prisma.config.ts"),
      `export default { schema: "schema.prisma", migrations: { path: "migrations" }, datasource: { url: process.env.MIGRATION_DATABASE_URL } };\n`,
    );
    args = ["--config", join(workDir, "prisma.config.ts")];
  }
  const child = startTsProcess(
    "src/migrate/run-migrations.ts",
    {
      MIGRATION_DATABASE_URL: container.url("migrator"),
      MIGRATION_DATABASE_SSL_MODE: "disable",
      BOOKING_RUNTIME_ROLE: runtimeRole,
    },
    args,
  );
  const exit = await child.exited;
  if (workDir !== undefined) {
    rmSync(workDir, { recursive: true, force: true });
  }
  if (exit.code !== 0) {
    throw new Error(`migrations failed: ${child.output()}`);
  }
};
