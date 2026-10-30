import { z } from "zod";
import { parseDatabaseUrl } from "../shared/database/database-url.js";

/**
 * Configuration of the notifications worker (its own entry point; the HTTP
 * API never starts it). Email settings are independent of the marketing flag.
 * Messages name variables and rules, never values.
 */
export type WorkerTuning = {
  pollIntervalMs: number;
  batchSize: number;
  /** How long a claimed delivery belongs to one worker. */
  leaseMs: number;
  /** Provider request timeout; well below the lease (see validation). */
  requestTimeoutMs: number;
  maxAttempts: number;
  /** Exponential backoff: base and cap (before jitter and Retry-After). */
  retryBaseMs: number;
  retryCapMs: number;
  /** Retry-After from the provider is honoured up to this limit. */
  retryAfterCapMs: number;
  /** Pause of the whole worker after a provider configuration error. */
  configurationPauseMs: number;
};

export const DEFAULT_TUNING: WorkerTuning = {
  pollIntervalMs: 5_000,
  batchSize: 10,
  leaseMs: 60_000,
  requestTimeoutMs: 20_000,
  maxAttempts: 8,
  retryBaseMs: 30_000,
  retryCapMs: 30 * 60_000,
  retryAfterCapMs: 6 * 60 * 60_000,
  configurationPauseMs: 5 * 60_000,
};

/** The lease must outlive a full request (timeout) with a safety margin. */
export const tuningErrors = (tuning: WorkerTuning): string[] =>
  tuning.leaseMs >= 2 * tuning.requestTimeoutMs + 10_000
    ? []
    : ["lease must be at least 2 × request timeout + 10 s"];

export type DeploymentEnvironment = "production" | "staging" | "development";

export type NotificationConfig =
  | { enabled: false; logLevel: LogLevel }
  | {
      enabled: true;
      logLevel: LogLevel;
      environment: DeploymentEnvironment;
      database: { url: string; sslMode: "verify-full" | "disable"; poolMax: number };
      studioEmail: string;
      /** Outside production: only these recipients get email; others are skipped visibly. */
      recipientAllowlist: ReadonlySet<string> | null;
      brevo: { apiKey: string; senderName: string; senderEmail: string };
    };

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export type NotificationConfigResult = { ok: true; config: NotificationConfig } | { ok: false; errors: string[] };

const emailSchema = z.email("must be a valid email address").transform((value) => value.toLowerCase());

const flagSchema = z
  .enum(["true", "false"], { error: "must be true or false" })
  .transform((value) => value === "true");

const optional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
};

const baseSchema = z.object({
  ENABLE_BOOKING_NOTIFICATIONS: flagSchema.default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

const enabledSchema = z.object({
  NOTIFICATIONS_ENVIRONMENT: z.enum(["production", "staging", "development"], {
    error: "must be production, staging or development",
  }),
  DATABASE_URL: z.string().min(1, "is required"),
  DATABASE_SSL_MODE: z.enum(["verify-full", "disable"], { error: "must be verify-full or disable" }).default("verify-full"),
  DATABASE_POOL_MAX: z
    .string()
    .regex(/^\d{1,2}$/, "must be an integer between 1 and 10")
    .transform(Number)
    .pipe(z.number().int().min(1, "must be an integer between 1 and 10").max(10, "must be an integer between 1 and 10"))
    .default(2),
  NOTIFICATION_STUDIO_EMAIL: emailSchema,
  NOTIFICATION_RECIPIENT_ALLOWLIST: z.string().optional(),
  BREVO_API_KEY: z.string().min(1, "is required"),
  EMAIL_FROM_NAME: z.string().min(1, "is required"),
  EMAIL_FROM_EMAIL: emailSchema,
});

const formatIssues = (issues: z.ZodError["issues"]): string[] =>
  issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`);

export const loadNotificationConfig = (env: Record<string, string | undefined>): NotificationConfigResult => {
  const base = baseSchema.safeParse({
    ENABLE_BOOKING_NOTIFICATIONS: optional(env.ENABLE_BOOKING_NOTIFICATIONS),
    LOG_LEVEL: optional(env.LOG_LEVEL),
  });
  if (!base.success) {
    return { ok: false, errors: formatIssues(base.error.issues) };
  }
  if (!base.data.ENABLE_BOOKING_NOTIFICATIONS) {
    return { ok: true, config: { enabled: false, logLevel: base.data.LOG_LEVEL } };
  }

  const parsed = enabledSchema.safeParse({
    NOTIFICATIONS_ENVIRONMENT: optional(env.NOTIFICATIONS_ENVIRONMENT),
    DATABASE_URL: env.DATABASE_URL,
    DATABASE_SSL_MODE: optional(env.DATABASE_SSL_MODE),
    DATABASE_POOL_MAX: optional(env.DATABASE_POOL_MAX),
    NOTIFICATION_STUDIO_EMAIL: optional(env.NOTIFICATION_STUDIO_EMAIL),
    NOTIFICATION_RECIPIENT_ALLOWLIST: optional(env.NOTIFICATION_RECIPIENT_ALLOWLIST),
    BREVO_API_KEY: optional(env.BREVO_API_KEY),
    EMAIL_FROM_NAME: optional(env.EMAIL_FROM_NAME),
    EMAIL_FROM_EMAIL: optional(env.EMAIL_FROM_EMAIL),
  });
  if (!parsed.success) {
    return { ok: false, errors: formatIssues(parsed.error.issues) };
  }
  const data = parsed.data;

  const databaseUrl = parseDatabaseUrl(data.DATABASE_URL, data.DATABASE_SSL_MODE);
  if (!databaseUrl.ok) {
    return { ok: false, errors: [`DATABASE_URL: ${databaseUrl.error}`] };
  }

  // Allowlist: required outside production (no email may go to real people
  // from staging or development), refused in production (never filter
  // production recipients by accident).
  let allowlist: Set<string> | null = null;
  if (data.NOTIFICATION_RECIPIENT_ALLOWLIST !== undefined) {
    const entries = data.NOTIFICATION_RECIPIENT_ALLOWLIST.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    const emails = z.array(emailSchema).min(1).safeParse(entries);
    if (!emails.success) {
      return { ok: false, errors: ["NOTIFICATION_RECIPIENT_ALLOWLIST: must be a comma-separated list of email addresses"] };
    }
    allowlist = new Set(emails.data);
  }
  if (data.NOTIFICATIONS_ENVIRONMENT === "production" && allowlist !== null) {
    return { ok: false, errors: ["NOTIFICATION_RECIPIENT_ALLOWLIST: must not be set in production"] };
  }
  if (data.NOTIFICATIONS_ENVIRONMENT !== "production" && allowlist === null) {
    return {
      ok: false,
      errors: [
        `NOTIFICATION_RECIPIENT_ALLOWLIST: required when NOTIFICATIONS_ENVIRONMENT=${data.NOTIFICATIONS_ENVIRONMENT} (sending does not start without explicit test recipients)`,
      ],
    };
  }

  return {
    ok: true,
    config: {
      enabled: true,
      logLevel: base.data.LOG_LEVEL,
      environment: data.NOTIFICATIONS_ENVIRONMENT,
      database: { url: data.DATABASE_URL, sslMode: data.DATABASE_SSL_MODE, poolMax: data.DATABASE_POOL_MAX },
      studioEmail: data.NOTIFICATION_STUDIO_EMAIL,
      recipientAllowlist: allowlist,
      brevo: { apiKey: data.BREVO_API_KEY, senderName: data.EMAIL_FROM_NAME, senderEmail: data.EMAIL_FROM_EMAIL },
    },
  };
};
