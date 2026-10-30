import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_TUNING, loadNotificationConfig, tuningErrors } from "../src/notifications/config.js";
import { retryDelayMs } from "../src/notifications/retry.js";

const ENABLED = {
  ENABLE_BOOKING_NOTIFICATIONS: "true",
  NOTIFICATIONS_ENVIRONMENT: "production",
  DATABASE_URL: "postgresql://booking_app:secret-value@db.example.invalid:5432/booking?sslmode=verify-full",
  NOTIFICATION_STUDIO_EMAIL: "Studio@Example.invalid",
  BREVO_API_KEY: "xkeysib-SENTINEL-KEY",
  EMAIL_FROM_NAME: "Studio",
  EMAIL_FROM_EMAIL: "noreply@example.invalid",
};

describe("notifications configuration", () => {
  it("is disabled by default and then needs nothing else", () => {
    expect(loadNotificationConfig({})).toEqual({ ok: true, config: { enabled: false, logLevel: "info" } });
    expect(loadNotificationConfig({ ENABLE_BOOKING_NOTIFICATIONS: "false", BREVO_API_KEY: "" })).toMatchObject({ ok: true, config: { enabled: false } });
  });

  it("is independent of the marketing flag", () => {
    const withoutMarketing = loadNotificationConfig({ ...ENABLED, ENABLE_MARKETING_SUBSCRIPTION: "false" });
    expect(withoutMarketing).toMatchObject({ ok: true, config: { enabled: true, studioEmail: "studio@example.invalid" } });
    expect(loadNotificationConfig({ ENABLE_MARKETING_SUBSCRIPTION: "true" })).toMatchObject({ ok: true, config: { enabled: false } });
  });

  it("requires the studio address and Brevo settings when enabled, without echoing values", () => {
    const result = loadNotificationConfig({ ENABLE_BOOKING_NOTIFICATIONS: "true", NOTIFICATIONS_ENVIRONMENT: "production", DATABASE_URL: ENABLED.DATABASE_URL });
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors.join("\n");
    expect(errors).toContain("NOTIFICATION_STUDIO_EMAIL");
    expect(errors).toContain("BREVO_API_KEY");
    expect(errors).toContain("EMAIL_FROM_EMAIL");
    const invalid = loadNotificationConfig({ ...ENABLED, NOTIFICATION_STUDIO_EMAIL: "not-an-email", BREVO_API_KEY: "xkeysib-SENTINEL-KEY" });
    expect(JSON.stringify(invalid)).not.toContain("SENTINEL");
    expect(JSON.stringify(invalid)).not.toContain("secret-value");
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

  it("the lease outlives the provider timeout", () => {
    expect(tuningErrors(DEFAULT_TUNING)).toEqual([]);
    expect(tuningErrors({ ...DEFAULT_TUNING, leaseMs: 30_000, requestTimeoutMs: 20_000 })).toHaveLength(1);
  });
});

describe("retry backoff", () => {
  const tuning = { retryBaseMs: 30_000, retryCapMs: 30 * 60_000, retryAfterCapMs: 6 * 3_600_000 };

  it("grows exponentially with jitter between half and the full step, capped", () => {
    expect(retryDelayMs(1, null, tuning, () => 0)).toBe(15_000);
    expect(retryDelayMs(1, null, tuning, () => 1)).toBe(30_000);
    expect(retryDelayMs(3, null, tuning, () => 1)).toBe(120_000);
    expect(retryDelayMs(20, null, tuning, () => 1)).toBe(30 * 60_000);
    expect(retryDelayMs(20, null, tuning, () => 0)).toBe(15 * 60_000);
  });

  it("never retries before Retry-After (itself capped)", () => {
    expect(retryDelayMs(1, 120_000, tuning, () => 0)).toBe(120_000);
    expect(retryDelayMs(1, 1_000, tuning, () => 1)).toBe(30_000);
    expect(retryDelayMs(1, 48 * 3_600_000, tuning, () => 0)).toBe(6 * 3_600_000);
  });
});

describe("component boundaries", () => {
  it("the worker never writes outbox events and never touches catalogue, profile or booking tables", () => {
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
