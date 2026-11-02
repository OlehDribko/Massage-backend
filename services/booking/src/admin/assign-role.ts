// Owner-only command to grant or revoke the admin role for one profile.
// No HTTP route can change roles. Usage (dry run unless --apply):
//   node dist/admin/assign-role.js --profile-id <uuid> --email <email> --role admin [--apply]
// Reads DATABASE_URL / DATABASE_SSL_MODE like the API (runtime role is enough).
import { parseArgs } from "node:util";
import { z } from "zod";
import { createLogger, describeError } from "../logging/logger.js";
import { createDatabase } from "../shared/database/database.js";
import { parseDatabaseUrl } from "../shared/database/database-url.js";
import { assignRole } from "../modules/profiles/role-assignment.js";

const logger = createLogger({ level: "info" });

const envSchema = z.object({
  DATABASE_URL: z.string().trim().min(1, "is required"),
  DATABASE_SSL_MODE: z
    .enum(["verify-full", "disable"], { error: "must be verify-full or disable" })
    .default("verify-full"),
});

const argsSchema = z
  .object({
    "profile-id": z.uuid("must be a profile id (UUID)"),
    email: z.string().trim().toLowerCase().pipe(z.email("must be an email address")),
    role: z.enum(["admin", "client"], { error: "must be admin or client" }),
    apply: z.boolean().default(false),
  })
  .strict();

// Exit codes: 0 done (or dry run), 1 configuration/database error, 2 refused.
const main = async (): Promise<number> => {
  let rawArgs: unknown;
  try {
    rawArgs = parseArgs({
      args: process.argv.slice(2),
      options: {
        "profile-id": { type: "string" },
        email: { type: "string" },
        role: { type: "string" },
        apply: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    logger.fatal({ errors: ["arguments: unknown option or missing value"] }, "invalid arguments");
    return 1;
  }

  const env = envSchema.safeParse(process.env);
  const args = argsSchema.safeParse(rawArgs);
  if (!env.success || !args.success) {
    const errors = [
      ...(env.success ? [] : env.error.issues),
      ...(args.success ? [] : args.error.issues),
    ].map((issue) => `${issue.path.map(String).join(".") || "arguments"}: ${issue.message}`);
    logger.fatal({ errors }, "invalid configuration");
    return 1;
  }

  const url = parseDatabaseUrl(env.data.DATABASE_URL, env.data.DATABASE_SSL_MODE);
  if (!url.ok) {
    logger.fatal({ errors: [`DATABASE_URL: ${url.error}`] }, "invalid configuration");
    return 1;
  }

  const database = createDatabase(
    {
      url: env.data.DATABASE_URL,
      sslMode: env.data.DATABASE_SSL_MODE,
      poolMax: 1,
      connectTimeoutMs: 10_000,
      queryTimeoutMs: 30_000,
    },
    logger,
  );

  try {
    const result = await assignRole(database.prisma, {
      profileId: args.data["profile-id"],
      expectedEmail: args.data.email,
      role: args.data.role,
      apply: args.data.apply,
    });

    if (!result.ok) {
      logger.error({ profileId: args.data["profile-id"], reason: result.reason }, "role assignment refused");
      return 2;
    }

    logger.info(
      {
        profileId: result.profileId,
        previousRole: result.previousRole,
        role: result.role,
        changed: result.changed,
        applied: result.applied,
        dryRun: !args.data.apply,
      },
      args.data.apply ? "role assignment done" : "dry run: nothing changed (add --apply)",
    );
    return 0;
  } catch (error) {
    logger.fatal({ error: describeError(error) }, "role assignment failed");
    return 1;
  } finally {
    await database.close();
  }
};

process.exitCode = await main();
