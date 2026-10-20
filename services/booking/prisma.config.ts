import "dotenv/config";
import { defineConfig } from "prisma/config";

// Migrations use their own connection (MIGRATION_DATABASE_URL, migrator role);
// the application uses DATABASE_URL. Without MIGRATION_DATABASE_URL no
// datasource is configured: `prisma generate` still works (it needs no
// database), while migrate commands fail instead of falling back to any URL.
const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  ...(migrationDatabaseUrl !== undefined && migrationDatabaseUrl !== ""
    ? { datasource: { url: migrationDatabaseUrl } }
    : {}),
});
