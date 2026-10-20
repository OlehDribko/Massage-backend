// Test-only Prisma config: a migration history whose second migration fails
// after the first one (and _prisma_migrations) were created. Used by the
// migration-runner integration tests; never part of the real migrations.
import { defineConfig } from "prisma/config";

const url = process.env.MIGRATION_DATABASE_URL;

export default defineConfig({
  schema: "schema.prisma",
  migrations: {
    path: "migrations",
  },
  ...(url !== undefined && url !== "" ? { datasource: { url } } : {}),
});
