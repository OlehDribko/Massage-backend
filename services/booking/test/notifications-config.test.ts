import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import {
  DEFAULT_TUNING,
  PROVIDER_IDEMPOTENCY_WINDOW_MS,
  lastAttemptWithinMs,
  loadNotificationConfig,
  tuningErrors,
} from "../src/notifications/config.js";
import { retryDelayMs } from "../src/notifications/retry.js";

const ENABLED = {
  ENABLE_BOOKING_NOTIFICATIONS: "true",
  NOTIFICATIONS_ENVIRONMENT: "production",
  NOTIFICATION_STUDIO_EMAIL: "Studio@Example.invalid",
  BREVO_API_KEY: "xkeysib-SENTINEL-KEY",
  EMAIL_FROM_NAME: "Studio",
  EMAIL_FROM_EMAIL: "noreply@example.invalid",
};

describe("notifications configuration", () => {
  it("is disabled by default and then needs nothing else", () => {
    expect(loadNotificationConfig({})).toEqual({ ok: true, config: { enabled: false } });
    expect(loadNotificationConfig({ ENABLE_BOOKING_NOTIFICATIONS: "false", BREVO_API_KEY: "" })).toMatchObject({ ok: true, config: { enabled: false } });
  });

  it("is independent of the marketing flag", () => {
    const withoutMarketing = loadNotificationConfig({ ...ENABLED, ENABLE_MARKETING_SUBSCRIPTION: "false" });
    expect(withoutMarketing).toMatchObject({ ok: true, config: { enabled: true, studioEmail: "studio@example.invalid" } });
    expect(loadNotificationConfig({ ENABLE_MARKETING_SUBSCRIPTION: "true" })).toMatchObject({ ok: true, config: { enabled: false } });
  });

  it("requires the studio address and Brevo settings when enabled, without echoing values", () => {
    const result = loadNotificationConfig({ ENABLE_BOOKING_NOTIFICATIONS: "true", NOTIFICATIONS_ENVIRONMENT: "production" });
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors.join("\n");
    expect(errors).toContain("NOTIFICATION_STUDIO_EMAIL");
    expect(errors).toContain("BREVO_API_KEY");
    expect(errors).toContain("EMAIL_FROM_EMAIL");
    const invalid = loadNotificationConfig({ ...ENABLED, NOTIFICATION_STUDIO_EMAIL: "not-an-email", BREVO_API_KEY: "xkeysib-SENTINEL-KEY" });
    expect(JSON.stringify(invalid)).not.toContain("SENTINEL");
    expect(JSON.stringify(invalid)).not.toContain("not-an-email");
  });

  it("staging and development do not start without an explicit allowlist; production refuses one", () => {
    for (const environment of ["staging", "development"]) {
      const missing = loadNotificationConfig({ ...ENABLED, NOTIFICATIONS_ENVIRONMENT: environment });
      expect(missing).toMatchObject({ ok: false });
      expect(missing.ok ? "" : missing.errors.join()).toContain("NOTIFICATION_RECIPIENT_ALLOWLIST: required");
    }
    const staging = loadNotificationConfig({
      ...ENABLED,
      NOTIFICATIONS_ENVIRONMENT: "staging",
      NOTIFICATION_RECIPIENT_ALLOWLIST: " Tester@Example.invalid, studio@example.invalid ",
    });
    expect(staging.ok && staging.config.enabled && [...(staging.config.recipientAllowlist ?? [])]).toEqual([
      "tester@example.invalid",
      "studio@example.invalid",
    ]);
    expect(loadNotificationConfig({ ...ENABLED, NOTIFICATIONS_ENVIRONMENT: "staging", NOTIFICATION_RECIPIENT_ALLOWLIST: "nope" })).toMatchObject({ ok: false });
    const production = loadNotificationConfig({ ...ENABLED, NOTIFICATION_RECIPIENT_ALLOWLIST: "a@example.invalid" });
    expect(production.ok ? "" : production.errors.join()).toContain("must not be set in production");
    expect(loadNotificationConfig({ ...ENABLED, NOTIFICATIONS_ENVIRONMENT: undefined })).toMatchObject({ ok: false });
  });

  it("is part of the API configuration: off by default, invalid settings stop the start-up", () => {
    const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://app@127.0.0.1:5432/booking", DATABASE_SSL_MODE: "disable" };
    const off = loadConfig(base);
    expect(off.ok && off.config.notifications).toEqual({ enabled: false });
    const broken = loadConfig({ ...base, ENABLE_BOOKING_NOTIFICATIONS: "true", NOTIFICATIONS_ENVIRONMENT: "staging", BREVO_API_KEY: "xkeysib-SENTINEL-KEY" });
    expect(broken.ok).toBe(false);
    expect(JSON.stringify(broken)).not.toContain("SENTINEL");
    expect(loadConfig({ ...base, ENABLE_BOOKING_NOTIFICATIONS: "yes" })).toMatchObject({ ok: false });
  });
});

describe("attempts and retry schedule", () => {
  it("three attempts per recipient: the first and two retries; the lease outlives the provider timeout", () => {
    expect(DEFAULT_TUNING.maxAttempts).toBe(3);
    expect(DEFAULT_TUNING.retryDelaysMs).toEqual([60_000, 300_000]);
    expect(tuningErrors(DEFAULT_TUNING)).toEqual([]);
    expect(tuningErrors({ ...DEFAULT_TUNING, leaseMs: 30_000, requestTimeoutMs: 20_000 })).toHaveLength(1);
    expect(tuningErrors({ ...DEFAULT_TUNING, maxAttempts: 4 })).toHaveLength(1);
  });

  it("all attempts of one email fit in the provider's idempotency window, even with the longest Retry-After", () => {
    expect(lastAttemptWithinMs(DEFAULT_TUNING)).toBeLessThan(PROVIDER_IDEMPOTENCY_WINDOW_MS);
    expect(tuningErrors({ ...DEFAULT_TUNING, retryAfterCapMs: 20 * 60_000 })).toContain(
      "all attempts must fit in the provider's idempotency window",
    );
  });

  it("1 minute, then 5 minutes, plus up to 20 % jitter", () => {
    expect(retryDelayMs(1, null, DEFAULT_TUNING, () => 0)).toBe(60_000);
    expect(retryDelayMs(1, null, DEFAULT_TUNING, () => 1)).toBe(72_000);
    expect(retryDelayMs(2, null, DEFAULT_TUNING, () => 0)).toBe(300_000);
    expect(retryDelayMs(2, null, DEFAULT_TUNING, () => 1)).toBe(360_000);
  });

  it("never earlier than Retry-After, which is honoured up to 10 minutes", () => {
    expect(retryDelayMs(1, 120_000, DEFAULT_TUNING, () => 0)).toBe(120_000);
    expect(retryDelayMs(1, 1_000, DEFAULT_TUNING, () => 0)).toBe(60_000);
    expect(retryDelayMs(2, 48 * 3_600_000, DEFAULT_TUNING, () => 0)).toBe(600_000);
  });
});

describe("component boundaries", () => {
  it("notifications never write outbox events and never touch catalogue, profile or booking tables", () => {
    const dir = fileURLToPath(new URL("../src/notifications/", import.meta.url));
    const source = readdirSync(dir)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => readFileSync(`${dir}${file}`, "utf8"))
      .join("\n");
    expect(source).not.toMatch(/outboxEvent\.(create|update|upsert|delete)/);
    expect(source).not.toMatch(/INSERT INTO "OutboxEvent"|UPDATE "OutboxEvent"|DELETE FROM "OutboxEvent"/);
    expect(source).not.toMatch(/\b(prisma|tx|db)\.(booking|service|userProfile|bookingTimeChange|weeklyScheduleInterval|scheduleException\w*)\b/);
    expect(source).not.toMatch(/"(Booking|Service|UserProfile|BookingTimeChange)"/);
    expect(source).not.toMatch(/from "\.\.\/modules\/(bookings|catalog|profiles|schedule)/);
  });
});
