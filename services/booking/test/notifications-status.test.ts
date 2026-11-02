import { describe, expect, it } from "vitest";
import {
  OVERDUE_AFTER_MS,
  clientReason,
  recipientStatus,
  type DeliveryRow,
  type EventRow,
} from "../src/notifications/status.js";

const NOW = new Date("2027-03-01T10:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const event = (overrides: Partial<EventRow> = {}): EventRow => ({
  type: "booking.created",
  occurredAt: minutes(-1),
  notification: { status: "planned", deliveries: [] },
  ...overrides,
});

const delivery = (overrides: Partial<DeliveryRow> = {}): DeliveryRow => ({
  recipientRole: "client",
  status: "pending",
  attempts: 0,
  resultCode: null,
  nextAttemptAt: minutes(0),
  leaseExpiresAt: null,
  updatedAt: minutes(-1),
  acceptedAt: null,
  ...overrides,
});

describe("notification status read model", () => {
  it("accepted means accepted by the provider; the time is shown, nothing else", () => {
    const status = recipientStatus(event(), delivery({ status: "accepted", attempts: 1, resultCode: "accepted", acceptedAt: minutes(-1) }), NOW);
    expect(status).toEqual({ status: "accepted", reason: null, attempts: 1, lastAttemptAt: minutes(-1).toISOString(), acceptedAt: minutes(-1).toISOString() });
  });

  it("pending: waiting for the first attempt, or a retry is scheduled", () => {
    expect(recipientStatus(event(), undefined, NOW)).toMatchObject({ status: "pending", reason: null, attempts: 0 });
    expect(recipientStatus(event(), delivery({ attempts: 1, nextAttemptAt: minutes(1) }), NOW)).toMatchObject({
      status: "pending",
      reason: "retry_scheduled",
    });
  });

  it("an attempt in progress is 'sending' only while its lease holds; afterwards 'interrupted', never forever 'sending'", () => {
    expect(recipientStatus(event(), delivery({ status: "in_progress", attempts: 1, leaseExpiresAt: minutes(1) }), NOW).status).toBe("sending");
    expect(recipientStatus(event(), delivery({ status: "in_progress", attempts: 1, leaseExpiresAt: minutes(-1) }), NOW)).toMatchObject({
      status: "interrupted",
      reason: "processing_interrupted",
    });
  });

  it("work nobody picked up for too long is reported as interrupted (delayed)", () => {
    const late = new Date(NOW.getTime() - OVERDUE_AFTER_MS - 1);
    expect(recipientStatus(event(), delivery({ nextAttemptAt: late }), NOW)).toMatchObject({ status: "interrupted", reason: "processing_delayed" });
    expect(recipientStatus(event({ occurredAt: late, notification: null }), undefined, NOW)).toMatchObject({
      status: "interrupted",
      reason: "processing_delayed",
    });
  });

  it("failed and skipped results map to fixed reasons; the client sees no provider or configuration details", () => {
    const cases: [Partial<DeliveryRow>, string, string | null][] = [
      [{ status: "failed", resultCode: "attempts_exhausted" }, "temporary_errors", "not_sent"],
      [{ status: "failed", resultCode: "retry_after_too_long" }, "provider_retry_after_too_long", "not_sent"],
      [{ status: "failed", resultCode: "provider_auth" }, "provider_configuration", "not_sent"],
      [{ status: "failed", resultCode: "provider_rejected" }, "provider_rejected", "not_sent"],
      [{ status: "failed", resultCode: "interrupted" }, "processing_interrupted", null],
      [{ status: "failed", resultCode: "recipient_missing" }, "no_valid_address", "no_valid_address"],
      [{ status: "failed", resultCode: "some_future_code" }, "other", "not_sent"],
      [{ status: "skipped", resultCode: "superseded" }, "superseded", "superseded"],
      [{ status: "skipped", resultCode: "session_already_started" }, "session_already_started", "session_already_started"],
      [{ status: "skipped", resultCode: "recipient_not_allowed" }, "test_environment", "test_environment"],
    ];
    for (const [row, adminReason, forClient] of cases) {
      const status = recipientStatus(event(), delivery(row), NOW);
      expect(status.reason).toBe(adminReason);
      expect(clientReason(status)).toBe(forClient);
    }
  });

  it("an event that cannot be used is a failed notification for both recipients", () => {
    expect(recipientStatus(event({ notification: { status: "invalid", deliveries: [] } }), undefined, NOW)).toMatchObject({
      status: "failed",
      reason: "invalid_event",
    });
  });
});
