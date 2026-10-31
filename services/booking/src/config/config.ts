import { z } from "zod";
import { loadNotificationConfig, type NotificationConfig } from "../notifications/config.js";
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
  // Driver-level limit for business queries (Prisma). Readiness uses its own
  // shorter per-query limit (READINESS_TIMEOUT_MS).
  DATABASE_QUERY_TIMEOUT_MS: positiveMsSchema.default(30_000),
  APP_VERSION: optionalNonEmpty.pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9._+-]{1,64}$/, "must be 1-64 characters [A-Za-z0-9._+-]")
      .optional(),
  ),
  FRONTEND_URL: optionalNonEmpty.pipe(httpUrlSchema.optional()),
  SHUTDOWN_TIMEOUT_MS: positiveMsSchema.default(10_000),
  READINESS_TIMEOUT_MS: positiveMsSchema.default(2_000),
  // Removed together with the legacy /api/users routes. "false" (still set by
  // existing deployments) is accepted and ignored; "true" is a startup error.
  ENABLE_LEGACY_USER_ROUTES: optionalNonEmpty.pipe(
    z
      .string()
      .toLowerCase()
      .pipe(
        z.literal("false", {
          error:
            "legacy /api/users routes were removed (Firebase Authentication replaces them); only false is accepted",
        }),
      )
      .optional(),
  ),
  ENABLE_MARKETING_SUBSCRIPTION: booleanFlagSchema.default(false),
  // Functional deployments set this: starting without Firebase is then a
  // configuration error instead of silently running without /api/me.
  REQUIRE_FIREBASE_AUTH: booleanFlagSchema.default(false),
  FIREBASE_PROJECT_ID: optionalNonEmpty.pipe(
    z
      .string()
      .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "must be a Firebase project id (6-30 characters [a-z0-9-])")
      .optional(),
  ),
  FIREBASE_CREDENTIALS: optionalNonEmpty.pipe(
    z
      .enum(["application-default", "service-account-json", "none"], {
        error: "must be one of application-default, service-account-json, none",
      })
      .optional(),
  ),
  FIREBASE_AUTH_EMULATOR_HOST: optionalNonEmpty.pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9.-]{1,253}:\d{1,5}$/, "must be host:port")
      .optional(),
  ),
});

const marketingEnvSchema = z.object({
  BREVO_API_KEY: nonEmpty,
  EMAIL_FROM_NAME: nonEmpty,
  EMAIL_FROM_EMAIL: z.email("must be a valid email address"),
  ACTION_TOKEN_SECRET: z.string().min(32, "must be at least 32 characters"),
  FRONTEND_URL: httpUrlSchema,
});

// Only the fields the Admin SDK needs; other keys of the JSON key file are ignored.
const serviceAccountSchema = z.object({
  type: z.literal("service_account", { error: "must be a service account key (type service_account)" }),
  project_id: nonEmpty,
  client_email: z.email("client_email must be an email address"),
  private_key: z
    .string()
    .refine((value) => value.includes("-----BEGIN PRIVATE KEY-----"), "private_key must be a PEM private key"),
});

export type MarketingConfig = {
  brevoApiKey: string;
  emailFromName: string;
  emailFromEmail: string;
  actionTokenSecret: string;
  frontendUrl: string;
};

export type FirebaseCredentials =
  | { kind: "application-default" }
  | { kind: "service-account"; clientEmail: string; privateKey: string }
  | { kind: "emulator"; host: string };

export type FirebaseConfig = {
  projectId: string;
  credentials: FirebaseCredentials;
};

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: z.output<typeof baseEnvSchema>["LOG_LEVEL"];
  databaseUrl: string;
  databaseSslMode: "verify-full" | "disable";
  databasePoolMax: number;
  databaseConnectTimeoutMs: number;
  databaseQueryTimeoutMs: number;
  appVersion: string | undefined;
  corsOrigin: string | undefined;
  shutdownTimeoutMs: number;
  readinessTimeoutMs: number;
  // Absent: no /api/me routes (authentication is unavailable, fail closed).
  firebase: FirebaseConfig | undefined;
  /** REQUIRE_FIREBASE_AUTH: when true, `firebase` is always present. */
  authRequired: boolean;
  marketing: MarketingConfig | undefined;
  /** Booking emails (src/notifications), sent from this process when enabled. */
  notifications: NotificationConfig;
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
    DATABASE_QUERY_TIMEOUT_MS: trimmed(env.DATABASE_QUERY_TIMEOUT_MS),
    APP_VERSION: env.APP_VERSION,
    FRONTEND_URL: env.FRONTEND_URL,
    SHUTDOWN_TIMEOUT_MS: trimmed(env.SHUTDOWN_TIMEOUT_MS),
    READINESS_TIMEOUT_MS: trimmed(env.READINESS_TIMEOUT_MS),
    ENABLE_LEGACY_USER_ROUTES: trimmed(env.ENABLE_LEGACY_USER_ROUTES),
    ENABLE_MARKETING_SUBSCRIPTION: trimmed(env.ENABLE_MARKETING_SUBSCRIPTION),
    REQUIRE_FIREBASE_AUTH: trimmed(env.REQUIRE_FIREBASE_AUTH),
    FIREBASE_PROJECT_ID: trimmed(env.FIREBASE_PROJECT_ID),
    FIREBASE_CREDENTIALS: trimmed(env.FIREBASE_CREDENTIALS),
    FIREBASE_AUTH_EMULATOR_HOST: trimmed(env.FIREBASE_AUTH_EMULATOR_HOST),
  });

  if (!base.success) {
    return { ok: false, errors: formatIssues(base.error.issues) };
  }

  const databaseUrl = parseDatabaseUrl(base.data.DATABASE_URL, base.data.DATABASE_SSL_MODE);
  if (!databaseUrl.ok) {
    return { ok: false, errors: [`DATABASE_URL: ${databaseUrl.error}`] };
  }

  const firebase = loadFirebaseConfig(base.data, env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!firebase.ok) {
    return { ok: false, errors: firebase.errors };
  }

  const marketing = loadMarketingConfig(base.data.ENABLE_MARKETING_SUBSCRIPTION, env);
  if (!marketing.ok) {
    return { ok: false, errors: marketing.errors };
  }

  const notifications = loadNotificationConfig(env);
  if (!notifications.ok) {
    return { ok: false, errors: notifications.errors };
  }

  return {
    ok: true,
    config: {
      nodeEnv: base.data.NODE_ENV,
      port: base.data.PORT,
      logLevel: base.data.LOG_LEVEL,
      databaseUrl: base.data.DATABASE_URL,
      databaseSslMode: base.data.DATABASE_SSL_MODE,
      databasePoolMax: base.data.DATABASE_POOL_MAX,
      databaseConnectTimeoutMs: base.data.DATABASE_CONNECT_TIMEOUT_MS,
      databaseQueryTimeoutMs: base.data.DATABASE_QUERY_TIMEOUT_MS,
      appVersion: base.data.APP_VERSION,
      corsOrigin: base.data.FRONTEND_URL,
      shutdownTimeoutMs: base.data.SHUTDOWN_TIMEOUT_MS,
      readinessTimeoutMs: base.data.READINESS_TIMEOUT_MS,
      firebase: firebase.value,
      authRequired: base.data.REQUIRE_FIREBASE_AUTH,
      marketing: marketing.value,
      notifications: notifications.config,
    },
  };
};

type Loaded<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const loadFirebaseConfig = (
  base: z.output<typeof baseEnvSchema>,
  serviceAccountJson: string | undefined,
): Loaded<FirebaseConfig | undefined> => {
  const projectId = base.FIREBASE_PROJECT_ID;
  const credentials = base.FIREBASE_CREDENTIALS;
  const emulatorHost = base.FIREBASE_AUTH_EMULATOR_HOST;
  const hasServiceAccountJson = trimmed(serviceAccountJson) !== undefined;

  // The Admin SDK switches to the emulator (unsigned tokens accepted) whenever
  // this variable is present, so production refuses to start with it at all.
  if (emulatorHost !== undefined && base.NODE_ENV === "production") {
    return {
      ok: false,
      errors: ["FIREBASE_AUTH_EMULATOR_HOST: must not be set when NODE_ENV=production (the Auth Emulator accepts unsigned tokens)"],
    };
  }

  if (projectId === undefined) {
    if (base.REQUIRE_FIREBASE_AUTH) {
      return {
        ok: false,
        errors: ["FIREBASE_PROJECT_ID: required when REQUIRE_FIREBASE_AUTH=true (authentication must be configured)"],
      };
    }
    if (credentials !== undefined || emulatorHost !== undefined || hasServiceAccountJson) {
      return { ok: false, errors: ["FIREBASE_PROJECT_ID: required when other FIREBASE_* variables are set"] };
    }
    return { ok: true, value: undefined };
  }

  if (emulatorHost !== undefined) {
    if (!projectId.startsWith("demo-")) {
      return {
        ok: false,
        errors: ['FIREBASE_PROJECT_ID: must start with "demo-" when FIREBASE_AUTH_EMULATOR_HOST is set (emulator projects never reach a real Firebase project)'],
      };
    }
    if ((credentials !== undefined && credentials !== "none") || hasServiceAccountJson) {
      return { ok: false, errors: ["FIREBASE_CREDENTIALS: must be none (or unset) with the Auth Emulator"] };
    }
    return { ok: true, value: { projectId, credentials: { kind: "emulator", host: emulatorHost } } };
  }

  if (projectId.startsWith("demo-")) {
    return { ok: false, errors: ['FIREBASE_PROJECT_ID: "demo-" project ids exist only in the Auth Emulator'] };
  }

  if (credentials === undefined || credentials === "none") {
    return {
      ok: false,
      errors: ["FIREBASE_CREDENTIALS: must be application-default or service-account-json without the Auth Emulator"],
    };
  }

  if (credentials === "application-default") {
    if (hasServiceAccountJson) {
      return {
        ok: false,
        errors: ["FIREBASE_SERVICE_ACCOUNT_JSON: set only with FIREBASE_CREDENTIALS=service-account-json"],
      };
    }
    return { ok: true, value: { projectId, credentials: { kind: "application-default" } } };
  }

  const serviceAccount = parseServiceAccount(serviceAccountJson, projectId);
  if (!serviceAccount.ok) {
    return serviceAccount;
  }
  return { ok: true, value: { projectId, credentials: serviceAccount.value } };
};

// Messages never include the key file or any part of it.
const parseServiceAccount = (
  json: string | undefined,
  projectId: string,
): Loaded<{ kind: "service-account"; clientEmail: string; privateKey: string }> => {
  if (trimmed(json) === undefined) {
    return {
      ok: false,
      errors: ["FIREBASE_SERVICE_ACCOUNT_JSON: required when FIREBASE_CREDENTIALS=service-account-json"],
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(json ?? "");
  } catch {
    return { ok: false, errors: ["FIREBASE_SERVICE_ACCOUNT_JSON: must be the JSON key file of a service account"] };
  }

  const parsed = serviceAccountSchema.safeParse(decoded);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `FIREBASE_SERVICE_ACCOUNT_JSON: ${issue.message}`),
    };
  }

  // Isolation between environments: a staging key cannot serve production.
  if (parsed.data.project_id !== projectId) {
    return {
      ok: false,
      errors: ["FIREBASE_SERVICE_ACCOUNT_JSON: project_id does not match FIREBASE_PROJECT_ID"],
    };
  }

  return {
    ok: true,
    value: {
      kind: "service-account",
      clientEmail: parsed.data.client_email,
      privateKey: parsed.data.private_key,
    },
  };
};

const loadMarketingConfig = (
  enabled: boolean,
  env: EnvSource,
): Loaded<MarketingConfig | undefined> => {
  if (!enabled) {
    return { ok: true, value: undefined };
  }

  const parsed = marketingEnvSchema.safeParse({
    BREVO_API_KEY: env.BREVO_API_KEY,
    EMAIL_FROM_NAME: env.EMAIL_FROM_NAME,
    EMAIL_FROM_EMAIL: trimmed(env.EMAIL_FROM_EMAIL),
    ACTION_TOKEN_SECRET: env.ACTION_TOKEN_SECRET,
    FRONTEND_URL: env.FRONTEND_URL,
  });

  if (!parsed.success) {
    return {
      ok: false,
      errors: formatIssues(parsed.error.issues).map(
        (message) => `${message} (required when ENABLE_MARKETING_SUBSCRIPTION=true)`,
      ),
    };
  }

  return {
    ok: true,
    value: {
      brevoApiKey: parsed.data.BREVO_API_KEY,
      emailFromName: parsed.data.EMAIL_FROM_NAME,
      emailFromEmail: parsed.data.EMAIL_FROM_EMAIL,
      actionTokenSecret: parsed.data.ACTION_TOKEN_SECRET,
      frontendUrl: parsed.data.FRONTEND_URL,
    },
  };
};
