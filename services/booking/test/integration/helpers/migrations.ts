import { startTsProcess } from "../../helpers/child-process.js";
import type { PostgresContainer } from "./postgres-container.js";

/** Runs the real migration runner (privileges + prisma migrate deploy + grants). */
export const runMigrations = async (container: PostgresContainer, runtimeRole = "booking_app") => {
  const child = startTsProcess("src/migrate/run-migrations.ts", {
    MIGRATION_DATABASE_URL: container.url("migrator"),
    MIGRATION_DATABASE_SSL_MODE: "disable",
    BOOKING_RUNTIME_ROLE: runtimeRole,
  });
  const exit = await child.exited;
  if (exit.code !== 0) {
    throw new Error(`migrations failed: ${child.output()}`);
  }
};
