import { z } from "zod";

/**
 * Configuration of booking notifications. They run inside the API process
 * (dispatcher.ts), woken by booking writes; there is no polling loop. Email
 * settings are independent of the marketing flag. Messages name variables
 * and rules, never values.
 */
export type WorkerTuning = {
  /** Deliveries claimed per statement. */
  batchSize: number;
  /** Outbox events planned per statement (planning repeats until done). */
  planBatchSize: number;
  /** How long a claimed delivery belongs to one process. */
  leaseMs: number;
  /** Provider request timeout; well below the lease (see validation). */
  requestTimeoutMs: number;
  /** Attempts per recipient, the first one included. */
  maxAttempts: number;
  /** Pause before retry n (index 0 = before the 2nd attempt); one entry per retry. */
  retryDelaysMs: number[];
  /** Up to this share is added at random, so simultaneous failures spread out. */
  retryJitterRatio: number;
  /** Retry-After from the provider is honoured up to this limit. */
  retryAfterCapMs: number;
};

export const DEFAULT_TUNING: WorkerTuning = {
  batchSize: 10,
  planBatchSize: 50,
  leaseMs: 60_000,
  requestTimeoutMs: 20_000,
  maxAttempts: 3,
  retryDelaysMs: [60_000, 5 * 60_000],
  retryJitterRatio: 0.2,
  retryAfterCapMs: 10 * 60_000,
};

/**
 * Brevo drops a repeat of an idempotency key only within 30 minutes of the
 * first request (docs/notifications.md). All attempts of one email must fit
 * in that window, so a repeat after a lost response is still recognised.
 */
export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 30 * 60_000;

/** Latest possible start of the last attempt, counted from the first. */
export const lastAttemptWithinMs = (tuning: WorkerTuning): number =>
  tuning.retryDelaysMs.reduce(
    (total, delay) => total + tuning.requestTimeoutMs + Math.max(delay * (1 + tuning.retryJitterRatio), tuning.retryAfterCapMs),
    0,
  );

export const tuningErrors = (tuning: WorkerTuning): string[] => {
  const errors: string[] = [];
  // The lease must outlive a full request (timeout) with a safety margin.
  if (tuning.leaseMs < 2 * tuning.requestTimeoutMs + 10_000) {
    errors.push("lease must be at least 2 × request timeout + 10 s");
  }
  if (tuning.retryDelaysMs.length !== tuning.maxAttempts - 1) {
    errors.push("retryDelaysMs must have one entry per retry (maxAttempts − 1)");
  }
  if (lastAttemptWithinMs(tuning) >= PROVIDER_IDEMPOTENCY_WINDOW_MS) {
    errors.push("all attempts must fit in the provider's idempotency window");
  }
  return errors;
};

export type DeploymentEnvironment = "production" | "staging" | "development";

export type NotificationConfig =
  | { enabled: false }
  | {
      enabled: true;
      environment: DeploymentEnvironment;
      studioEmail: string;
      /** Outside production: only these recipients get email; others are skipped visibly. */
      recipientAllowlist: ReadonlySet<string> | null;
      brevo: { apiKey: string; senderName: string; senderEmail: string };
    };

export type NotificationConfigResult = { ok: true; config: NotificationConfig } | { ok: false; errors: string[] };

const emailSchema = z.email("must be a valid email address").transform((value) => value.toLowerCase());

const flagSchema = z
  .enum(["true", "false"], { error: "must be true or false" })
  .transform((value) => value === "true");

const optional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
};

const enabledSchema = z.object({
  NOTIFICATIONS_ENVIRONMENT: z.enum(["production", "staging", "development"], {
    error: "must be production, staging or development",
  }),
  NOTIFICATION_STUDIO_EMAIL: emailSchema,
  NOTIFICATION_RECIPIENT_ALLOWLIST: z.string().optional(),
  BREVO_API_KEY: z.string().min(1, "is required"),
  EMAIL_FROM_NAME: z.string().min(1, "is required"),
  EMAIL_FROM_EMAIL: emailSchema,
});

const formatIssues = (issues: z.ZodError["issues"]): string[] =>
  issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`);

export const loadNotificationConfig = (env: Record<string, string | undefined>): NotificationConfigResult => {
  const flag = flagSchema.default(false).safeParse(optional(env.ENABLE_BOOKING_NOTIFICATIONS));
  if (!flag.success) {
    return { ok: false, errors: formatIssues(flag.error.issues).map((issue) => `ENABLE_BOOKING_NOTIFICATIONS${issue}`) };
  }
  if (!flag.data) {
    return { ok: true, config: { enabled: false } };
  }

  const parsed = enabledSchema.safeParse({
    NOTIFICATIONS_ENVIRONMENT: optional(env.NOTIFICATIONS_ENVIRONMENT),
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
      environment: data.NOTIFICATIONS_ENVIRONMENT,
      studioEmail: data.NOTIFICATION_STUDIO_EMAIL,
      recipientAllowlist: allowlist,
      brevo: { apiKey: data.BREVO_API_KEY, senderName: data.EMAIL_FROM_NAME, senderEmail: data.EMAIL_FROM_EMAIL },
    },
  };
};
