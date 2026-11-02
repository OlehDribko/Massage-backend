import type { PrismaClient } from "../generated/prisma/client.js";

/**
 * Read model of notification results for the booking API. The booking status
 * and the notification status are separate: a failed email never changes the
 * booking. Only fixed, safe codes leave this module: no provider text, no
 * addresses, no internal identifiers.
 *
 * "accepted" means accepted by the email provider for sending, not
 * "delivered to the mailbox" (delivery webhooks are not part of this stage).
 */
export type NotificationState =
  /** Waiting for its first attempt or for a scheduled retry. */
  | "pending"
  /** An attempt is running now. */
  | "sending"
  | "accepted"
  | "failed"
  /** Not sent on purpose, by an agreed rule. */
  | "skipped"
  /**
   * Processing stopped before a result (the process handling it stopped) and
   * nothing has picked it up since; it resumes when the service restarts or
   * the next booking change wakes the sender.
   */
  | "interrupted";

export type ClientNotificationReason =
  | "retry_scheduled"
  | "superseded"
  | "session_already_started"
  | "test_environment"
  | "no_valid_address"
  | "not_sent";

export type AdminNotificationReason =
  | "retry_scheduled"
  | "superseded"
  | "session_already_started"
  | "test_environment"
  | "no_valid_address"
  | "temporary_errors"
  | "provider_retry_after_too_long"
  | "provider_rejected"
  | "provider_configuration"
  | "invalid_event"
  | "processing_interrupted"
  | "processing_delayed"
  | "other";

export type NotificationEventKind = "created" | "rescheduled" | "cancelled";

/** The client's own email about the latest change of the booking. */
export type ClientNotificationStatus = {
  event: NotificationEventKind;
  status: NotificationState;
  reason: ClientNotificationReason | null;
};

export type AdminRecipientStatus = {
  status: NotificationState;
  reason: AdminNotificationReason | null;
  attempts: number;
  lastAttemptAt: string | null;
  acceptedAt: string | null;
};

/** Both recipients' results for one change of the booking. */
export type AdminNotificationStatus = {
  event: NotificationEventKind;
  occurredAt: string;
  client: AdminRecipientStatus;
  studio: AdminRecipientStatus;
};

export type NotificationStatusReader = {
  /** Booking id → the client's status for the latest event (bookings without events are absent). */
  forClient: (bookingIds: string[]) => Promise<Map<string, ClientNotificationStatus>>;
  /** Booking id → both recipients' statuses for every event, oldest first. */
  forAdmin: (bookingIds: string[]) => Promise<Map<string, AdminNotificationStatus[]>>;
};

/** Pending work this late (or a never-planned event this old) is reported as interrupted. */
export const OVERDUE_AFTER_MS = 15 * 60_000;

const EVENT_KINDS: Record<string, NotificationEventKind> = {
  "booking.created": "created",
  "booking.rescheduled": "rescheduled",
  "booking.cancelled": "cancelled",
};

export type DeliveryRow = {
  recipientRole: "client" | "studio";
  status: "pending" | "in_progress" | "accepted" | "failed" | "skipped";
  attempts: number;
  resultCode: string | null;
  nextAttemptAt: Date;
  leaseExpiresAt: Date | null;
  updatedAt: Date;
  acceptedAt: Date | null;
};

export type EventRow = {
  type: string;
  occurredAt: Date;
  notification: { status: "planned" | "invalid"; deliveries: DeliveryRow[] } | null;
};

const FAILED_REASONS: Record<string, AdminNotificationReason> = {
  attempts_exhausted: "temporary_errors",
  retry_after_too_long: "provider_retry_after_too_long",
  interrupted: "processing_interrupted",
  provider_rejected: "provider_rejected",
  provider_auth: "provider_configuration",
  provider_forbidden: "provider_configuration",
  provider_account: "provider_configuration",
  recipient_missing: "no_valid_address",
  recipient_invalid: "no_valid_address",
  invalid_payload: "invalid_event",
  inconsistent_payload: "invalid_event",
  unsupported_aggregate: "invalid_event",
  unsupported_event_type: "invalid_event",
  unsupported_schema_version: "invalid_event",
};

const SKIPPED_REASONS: Record<string, AdminNotificationReason> = {
  superseded: "superseded",
  session_already_started: "session_already_started",
  recipient_not_allowed: "test_environment",
};

/** Admin view of one recipient's delivery (undefined = not planned yet). */
export const recipientStatus = (event: EventRow, delivery: DeliveryRow | undefined, now: Date): AdminRecipientStatus => {
  const at = now.getTime();
  const base = {
    attempts: delivery?.attempts ?? 0,
    lastAttemptAt: delivery !== undefined && delivery.attempts > 0 ? delivery.updatedAt.toISOString() : null,
    acceptedAt: delivery?.acceptedAt?.toISOString() ?? null,
  };
  if (event.notification?.status === "invalid") {
    return { ...base, status: "failed", reason: "invalid_event" };
  }
  if (delivery === undefined) {
    return event.occurredAt.getTime() + OVERDUE_AFTER_MS < at
      ? { ...base, status: "interrupted", reason: "processing_delayed" }
      : { ...base, status: "pending", reason: null };
  }
  switch (delivery.status) {
    case "accepted":
      return { ...base, status: "accepted", reason: null };
    case "skipped":
      return { ...base, status: "skipped", reason: SKIPPED_REASONS[delivery.resultCode ?? ""] ?? "other" };
    case "failed":
      return { ...base, status: "failed", reason: FAILED_REASONS[delivery.resultCode ?? ""] ?? "other" };
    case "in_progress":
      return delivery.leaseExpiresAt !== null && delivery.leaseExpiresAt.getTime() <= at
        ? { ...base, status: "interrupted", reason: "processing_interrupted" }
        : { ...base, status: "sending", reason: null };
    case "pending":
      if (delivery.nextAttemptAt.getTime() + OVERDUE_AFTER_MS < at) {
        return { ...base, status: "interrupted", reason: "processing_delayed" };
      }
      return { ...base, status: "pending", reason: delivery.attempts > 0 ? "retry_scheduled" : null };
  }
};

/** What the client may see: fewer, plain reasons; nothing about provider or configuration. */
export const clientReason = (status: AdminRecipientStatus): ClientNotificationReason | null => {
  switch (status.reason) {
    case "retry_scheduled":
    case "superseded":
    case "session_already_started":
    case "test_environment":
    case "no_valid_address":
      return status.reason;
    case null:
    case "processing_interrupted":
    case "processing_delayed":
      return null;
    case "temporary_errors":
    case "provider_retry_after_too_long":
    case "provider_rejected":
    case "provider_configuration":
    case "invalid_event":
    case "other":
      return "not_sent";
  }
};

const deliveryOf = (event: EventRow, role: "client" | "studio"): DeliveryRow | undefined =>
  event.notification?.deliveries.find((delivery) => delivery.recipientRole === role);

export const createNotificationStatusReader = ({
  prisma,
  now,
}: {
  prisma: PrismaClient;
  now: () => Date;
}): NotificationStatusReader => {
  /** One query for all requested bookings: events with their notification rows. */
  const load = async (bookingIds: string[]): Promise<Map<string, (EventRow & { kind: NotificationEventKind })[]>> => {
    const byBooking = new Map<string, (EventRow & { kind: NotificationEventKind })[]>();
    if (bookingIds.length === 0) {
      return byBooking;
    }
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateType: "booking", aggregateId: { in: bookingIds } },
      orderBy: { position: "asc" },
      select: {
        aggregateId: true,
        type: true,
        occurredAt: true,
        notification: {
          select: {
            status: true,
            deliveries: {
              select: {
                recipientRole: true,
                status: true,
                attempts: true,
                resultCode: true,
                nextAttemptAt: true,
                leaseExpiresAt: true,
                updatedAt: true,
                acceptedAt: true,
              },
            },
          },
        },
      },
    });
    for (const event of events) {
      const kind = EVENT_KINDS[event.type];
      if (kind === undefined) {
        continue;
      }
      const list = byBooking.get(event.aggregateId) ?? [];
      list.push({ ...event, kind });
      byBooking.set(event.aggregateId, list);
    }
    return byBooking;
  };

  return {
    forClient: async (bookingIds) => {
      const current = now();
      const result = new Map<string, ClientNotificationStatus>();
      for (const [bookingId, events] of await load(bookingIds)) {
        const latest = events.at(-1);
        if (latest !== undefined) {
          const status = recipientStatus(latest, deliveryOf(latest, "client"), current);
          result.set(bookingId, { event: latest.kind, status: status.status, reason: clientReason(status) });
        }
      }
      return result;
    },
    forAdmin: async (bookingIds) => {
      const current = now();
      const result = new Map<string, AdminNotificationStatus[]>();
      for (const [bookingId, events] of await load(bookingIds)) {
        result.set(
          bookingId,
          events.map((event) => ({
            event: event.kind,
            occurredAt: event.occurredAt.toISOString(),
            client: recipientStatus(event, deliveryOf(event, "client"), current),
            studio: recipientStatus(event, deliveryOf(event, "studio"), current),
          })),
        );
      }
      return result;
    },
  };
};
