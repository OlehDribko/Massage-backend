import { z } from "zod";
import { parseDatabaseUrl } from "../shared/database/database-url.js";

const nonEmpty = z.string().trim().min(1, "must not be empty");

const optionalNonEmpty = z.preprocess(
  (value) => (value === "" ? undefined : value),
  nonEmpty.optional(),
);

const portSchema = z
  .string()
  .regex(/^\d{1,5}$/, "must be an integer between 1 and 65535")
  .transform(Number)
  .pipe(
    z
      .number()
      .int()
      .min(1, "must be an integer between 1 and 65535")
      .max(65535, "must be an integer between 1 and 65535"),
  );

const positiveMsSchema = z
  .string()
  .regex(/^\d{1,7}$/, "must be a positive integer (milliseconds)")
  .transform(Number)
  .pipe(z.number().int().min(1, "must be a positive integer (milliseconds)"));

// Only the literal strings "true"/"false" are accepted, so "false" never becomes true.
const booleanFlagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["true", "false"], { error: 'must be "true" or "false"' }))
  .transform((value) => value === "true");

const httpUrlSchema = z
  .string()
  .trim()
  .refine(
    (value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol),
    "must be an http:// or https:// URL",
  );

const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"], {
      error: "must be one of development, test, production",
    })
    .default("production"),
  PORT: portSchema.default(3001),
  LOG_LEVEL: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(
      z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"], {
        error: "must be one of fatal, error, warn, info, debug, trace, silent",
      }),
    )
    .default("info"),
  // Structure and parameters are checked in loadConfig together with DATABASE_SSL_MODE.
  DATABASE_URL: nonEmpty,
  // TLS with certificate verification unless explicitly disabled (local only).
  DATABASE_SSL_MODE: z
    .enum(["verify-full", "disable"], { error: "must be verify-full or disable" })
    .default("verify-full"),
  DATABASE_POOL_MAX: z
    .string()
    .regex(/^\d{1,3}$/, "must be an integer between 1 and 50")
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(1, "must be an integer between 1 and 50")
        .max(50, "must be an integer between 1 and 50"),
    )
    .default(5),
  DATABASE_CONNECT_TIMEOUT_MS: positiveMsSchema.default(5_000),
  APP_VERSION: optionalNonEmpty.pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9._+-]{1,64}$/, "must be 1-64 characters [A-Za-z0-9._+-]")
      .optional(),
  ),
  FRONTEND_URL: optionalNonEmpty.pipe(httpUrlSchema.optional()),
  SHUTDOWN_TIMEOUT_MS: positiveMsSchema.default(10_000),
  READINESS_TIMEOUT_MS: positiveMsSchema.default(2_000),
  ENABLE_LEGACY_USER_ROUTES: booleanFlagSchema.default(false),
});

const legacyEnvSchema = z.object({
  BREVO_API_KEY: nonEmpty,
  EMAIL_FROM_NAME: nonEmpty,
  EMAIL_FROM_EMAIL: z.email("must be a valid email address"),
  ACTION_TOKEN_SECRET: nonEmpty,
  FRONTEND_URL: httpUrlSchema,
});

export type LegacyUserRoutesConfig = {
  brevoApiKey: string;
  emailFromName: string;
  emailFromEmail: string;
  actionTokenSecret: string;
  frontendUrl: string;
};

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: z.output<typeof baseEnvSchema>["LOG_LEVEL"];
  databaseUrl: string;
  databaseSslMode: "verify-full" | "disable";
  databasePoolMax: number;
  databaseConnectTimeoutMs: number;
  appVersion: string | undefined;
  corsOrigin: string | undefined;
  shutdownTimeoutMs: number;
  readinessTimeoutMs: number;
  legacyUserRoutes:
    | { enabled: false }
    | ({ enabled: true } & LegacyUserRoutesConfig);
};

export type ConfigResult =
  | { ok: true; config: AppConfig }
  | { ok: false; errors: string[] };

type EnvSource = Record<string, string | undefined>;

// Messages name the variable and the rule, never the received value.
const formatIssues = (issues: z.ZodError["issues"]): string[] =>
  issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`);

const trimmed = (value: string | undefined): string | undefined => {
  const result = value?.trim();
  return result === "" ? undefined : result;
};

export const loadConfig = (env: EnvSource): ConfigResult => {
  const base = baseEnvSchema.safeParse({
    NODE_ENV: trimmed(env.NODE_ENV),
    PORT: trimmed(env.PORT),
    LOG_LEVEL: trimmed(env.LOG_LEVEL),
    DATABASE_URL: env.DATABASE_URL,
    DATABASE_SSL_MODE: trimmed(env.DATABASE_SSL_MODE),
    DATABASE_POOL_MAX: trimmed(env.DATABASE_POOL_MAX),
    DATABASE_CONNECT_TIMEOUT_MS: trimmed(env.DATABASE_CONNECT_TIMEOUT_MS),
    APP_VERSION: env.APP_VERSION,
    FRONTEND_URL: env.FRONTEND_URL,
    SHUTDOWN_TIMEOUT_MS: trimmed(env.SHUTDOWN_TIMEOUT_MS),
    READINESS_TIMEOUT_MS: trimmed(env.READINESS_TIMEOUT_MS),
    ENABLE_LEGACY_USER_ROUTES: trimmed(env.ENABLE_LEGACY_USER_ROUTES),
  });

  if (!base.success) {
    return { ok: false, errors: formatIssues(base.error.issues) };
  }

  const databaseUrl = parseDatabaseUrl(base.data.DATABASE_URL, base.data.DATABASE_SSL_MODE);
  if (!databaseUrl.ok) {
    return { ok: false, errors: [`DATABASE_URL: ${databaseUrl.error}`] };
  }

  const config: AppConfig = {
    nodeEnv: base.data.NODE_ENV,
    port: base.data.PORT,
    logLevel: base.data.LOG_LEVEL,
    databaseUrl: base.data.DATABASE_URL,
    databaseSslMode: base.data.DATABASE_SSL_MODE,
    databasePoolMax: base.data.DATABASE_POOL_MAX,
    databaseConnectTimeoutMs: base.data.DATABASE_CONNECT_TIMEOUT_MS,
    appVersion: base.data.APP_VERSION,
    corsOrigin: base.data.FRONTEND_URL,
    shutdownTimeoutMs: base.data.SHUTDOWN_TIMEOUT_MS,
    readinessTimeoutMs: base.data.READINESS_TIMEOUT_MS,
    legacyUserRoutes: { enabled: false },
  };

  if (!base.data.ENABLE_LEGACY_USER_ROUTES) {
    return { ok: true, config };
  }

  const legacy = legacyEnvSchema.safeParse({
    BREVO_API_KEY: env.BREVO_API_KEY,
    EMAIL_FROM_NAME: env.EMAIL_FROM_NAME,
    EMAIL_FROM_EMAIL: trimmed(env.EMAIL_FROM_EMAIL),
    ACTION_TOKEN_SECRET: env.ACTION_TOKEN_SECRET,
    FRONTEND_URL: env.FRONTEND_URL,
  });

  if (!legacy.success) {
    return {
      ok: false,
      errors: formatIssues(legacy.error.issues).map(
        (message) => `${message} (required when ENABLE_LEGACY_USER_ROUTES=true)`,
      ),
    };
  }

  return {
    ok: true,
    config: {
      ...config,
      legacyUserRoutes: {
        enabled: true,
        brevoApiKey: legacy.data.BREVO_API_KEY,
        emailFromName: legacy.data.EMAIL_FROM_NAME,
        emailFromEmail: legacy.data.EMAIL_FROM_EMAIL,
        actionTokenSecret: legacy.data.ACTION_TOKEN_SECRET,
        frontendUrl: legacy.data.FRONTEND_URL,
      },
    },
  };
};
