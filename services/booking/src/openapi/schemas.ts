import { z } from "zod";

/**
 * Response schemas of the HTTP API, for the OpenAPI document only (requests
 * reuse the validation schemas of the modules). They mirror the view types
 * of the modules: test/openapi-types.test.ts checks them against those types
 * at compile time, and the contract tests parse real responses with them
 * (strict objects: an undocumented field fails the test). Examples use
 * invented data only.
 */

const instant = z.iso.datetime().meta({ description: "Moment in UTC, ISO 8601 with Z", examples: ["2027-03-02T08:00:00.000Z"] });
const localDate = z.iso.date().meta({ description: "Local date of the studio (Europe/Paris), YYYY-MM-DD", examples: ["2027-03-02"] });
const localTime = z.string().meta({ description: "Local time of the studio, HH:MM (00:00–24:00)", examples: ["09:00"] });
const uuid = z.uuid();
const cents = z.int().min(0).meta({ description: "Integer euro cents" });

// --- Errors -----------------------------------------------------------------

export const bookingBlockerSchema = z.enum([
  "anonymous_session",
  "email_not_verified",
  "name_missing",
  "phone_missing",
  "not_a_client",
]);

export const errorSchema = z
  .strictObject({
    message: z.string().meta({ description: "Human-readable, English; do not parse" }),
    code: z.string().optional().meta({ description: "Stable machine-readable code (see each operation)" }),
    errors: z
      .array(z.strictObject({ field: z.array(z.union([z.string(), z.number()])), message: z.string() }))
      .optional()
      .meta({ description: "VALIDATION_FAILED: one entry per invalid field" }),
    blockers: z.array(bookingBlockerSchema).optional().meta({ description: "BOOKING_NOT_READY: what still prevents booking" }),
    reason: z
      .enum(["too_soon", "beyond_horizon", "outside_schedule", "taken"])
      .optional()
      .meta({ description: "SLOT_UNAVAILABLE: why the start is not available" }),
    retryAfterSeconds: z
      .int()
      .optional()
      .meta({ description: "When to retry (also sent as the Retry-After header): AUTH_UNAVAILABLE, CALENDAR_BUSY, CONFIRMATION_EMAIL_NOT_SENT" }),
    currentConsentTextVersion: z.string().optional().meta({ description: "CONSENT_TEXT_OUTDATED: the version to show instead" }),
    conflicts: z
      .array(z.strictObject({ bookingId: uuid, startsAt: instant, endsAt: instant, serviceName: z.string() }))
      .optional()
      .meta({ description: "SCHEDULE_CONFLICT: active bookings the change would leave outside working hours" }),
  })
  .meta({ id: "Error", examples: [{ message: "Validation failed", code: "VALIDATION_FAILED", errors: [{ field: ["startsAt"], message: "Invalid ISO datetime" }] }] });

// --- Health -----------------------------------------------------------------

export const liveSchema = z.strictObject({ status: z.literal("ok") }).meta({ id: "Live" });
export const readySchema = z
  .strictObject({ status: z.literal("ready"), version: z.string().optional().meta({ description: "Deployed commit (APP_VERSION), when set" }) })
  .meta({ id: "Ready" });
export const notReadySchema = z
  .strictObject({ status: z.literal("unavailable"), reason: z.enum(["shutting_down", "database_unavailable"]) })
  .meta({ id: "NotReady" });

// --- Catalogue and availability ---------------------------------------------

export const publicServiceSchema = z
  .strictObject({
    id: uuid.meta({ description: "Stable service id; the frontend keys photos and texts by it" }),
    name: z.string(),
    durationMinutes: z.int().meta({ description: "Length of the session, minutes" }),
    priceCents: cents.meta({ description: "Regular price, integer euro cents" }),
    effectivePriceCents: cents.meta({ description: "Price of a booking created now: the sale price while a sale is active, otherwise priceCents" }),
    salePriceCents: cents.nullable().meta({ description: "Only while a sale is active; otherwise null" }),
    saleEndsAt: instant.nullable().meta({ description: "End of the active sale (UTC, exclusive); otherwise null" }),
    currency: z.literal("EUR"),
  })
  .meta({
    id: "Service",
    examples: [
      {
        id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
        name: "Massage example",
        durationMinutes: 60,
        priceCents: 8500,
        effectivePriceCents: 6900,
        salePriceCents: 6900,
        saleEndsAt: "2026-11-30T23:00:00.000Z",
        currency: "EUR",
      },
    ],
  });

export const availabilitySchema = z
  .strictObject({
    serviceId: uuid,
    durationMinutes: z.int(),
    timeZone: z.literal("Europe/Paris"),
    from: localDate,
    to: localDate,
    days: z.array(
      z.strictObject({
        date: localDate,
        slots: z.array(z.strictObject({ startsAt: instant, endsAt: instant })).meta({ description: "Free starts of that day, in order" }),
      }),
    ),
  })
  .meta({ id: "Availability" });

// --- Profiles and marketing -------------------------------------------------

export const marketingStatusSchema = z
  .strictObject({
    subscribed: z.boolean(),
    pendingConfirmation: z.boolean().meta({ description: "A confirmation email is outstanding" }),
    consentGivenAt: instant.nullable(),
    consentSource: z.enum(["signup_checkbox", "subscription_form", "account_request"]).nullable(),
    consentTextVersion: z.string().nullable(),
    unsubscribedAt: instant.nullable(),
  })
  .meta({ id: "MarketingStatus" });

export const profileViewSchema = z
  .strictObject({
    profile: z.strictObject({
      id: uuid,
      role: z.enum(["client", "admin"]),
      authState: z.enum(["anonymous", "registered"]).meta({ description: "anonymous = Firebase anonymous sign-in (guest)" }),
      name: z.string().nullable(),
      email: z.string().nullable(),
      emailVerified: z.boolean(),
      phone: z.string().nullable().meta({ description: "E.164", examples: ["+33612345678"] }),
      signInProvider: z.string().meta({ examples: ["password", "google.com", "anonymous"] }),
      createdAt: instant,
      updatedAt: instant,
    }),
    bookingReadiness: z
      .strictObject({ ready: z.boolean(), blockers: z.array(bookingBlockerSchema) })
      .meta({ description: "Informational; booking routes re-check on the server" }),
    marketing: marketingStatusSchema.nullable().meta({ description: "null unless the profile has a verified email" }),
  })
  .meta({ id: "ProfileView" });

export const optInOutcomeSchema = z.enum([
  "confirmation_sent",
  "delivery_failed",
  "no_action",
  "unavailable",
  "consent_text_outdated",
  "failed",
]);

export const syncResponseSchema = profileViewSchema
  .extend({
    marketingOptIn: z
      .strictObject({ outcome: optInOutcomeSchema, currentConsentTextVersion: z.string() })
      .optional()
      .meta({ description: "Only when the request had marketingOptIn: true; the sync itself succeeded in every case" }),
  })
  .meta({ id: "SyncResponse" });

export const ownSubscriptionRequestedSchema = z
  .strictObject({
    outcome: z.enum(["confirmation_sent", "no_action"]),
    retryAfterSeconds: z
      .int()
      .positive()
      .optional()
      .meta({ description: "no_action while a confirmation was sent recently (or after a provider rate limit): seconds until 'send again' may send" }),
  })
  .meta({ id: "OwnSubscriptionRequested" });

// --- Notifications (separate from the booking status) -----------------------

const notificationState = z
  .enum(["pending", "sending", "accepted", "failed", "skipped", "interrupted"])
  .meta({ description: "accepted = accepted by the email provider for sending, NOT delivered to the mailbox" });
const notificationEvent = z.enum(["created", "rescheduled", "cancelled"]);

export const clientNotificationSchema = z
  .strictObject({
    event: notificationEvent,
    status: notificationState,
    reason: z
      .enum(["retry_scheduled", "superseded", "session_already_started", "test_environment", "no_valid_address", "not_sent"])
      .nullable(),
  })
  .meta({ id: "ClientNotification", description: "The client's own email about the latest change of the booking" });

const adminRecipient = z.strictObject({
  status: notificationState,
  reason: z
    .enum([
      "retry_scheduled",
      "superseded",
      "session_already_started",
      "test_environment",
      "no_valid_address",
      "temporary_errors",
      "provider_retry_after_too_long",
      "provider_rejected",
      "provider_configuration",
      "invalid_event",
      "processing_interrupted",
      "processing_delayed",
      "other",
    ])
    .nullable(),
  attempts: z.int().min(0).meta({ description: "At most 3 per recipient" }),
  lastAttemptAt: instant.nullable(),
  acceptedAt: instant.nullable(),
});

export const adminNotificationSchema = z
  .strictObject({ event: notificationEvent, occurredAt: instant, client: adminRecipient, studio: adminRecipient })
  .meta({ id: "AdminNotification" });

// --- Bookings -----------------------------------------------------------------

const timeRange = z.strictObject({ startsAt: instant, endsAt: instant });

const bookingBase = {
  id: uuid,
  status: z.enum(["confirmed", "cancelled"]),
  phase: z.enum(["upcoming", "in_progress", "finished", "cancelled"]).meta({ description: "Derived from the server clock" }),
  timeZone: z.string().meta({ examples: ["Europe/Paris"] }),
  startsAt: instant,
  endsAt: instant,
  service: z
    .strictObject({ id: uuid, name: z.string(), durationMinutes: z.int(), priceCents: cents, currency: z.string() })
    .meta({ description: "Snapshot taken when the booking was created: priceCents is the agreed price (the sale price if a sale was active then). Never changed afterwards (rescheduling, end of a sale, catalogue changes)" }),
  payment: z.literal("on_site").meta({ description: "Paid at the studio; no online payment" }),
  cancellation: z.strictObject({ by: z.enum(["client", "admin"]), at: instant, reason: z.string().nullable() }).nullable(),
  allowedActions: z
    .strictObject({ reschedule: z.boolean(), cancel: z.boolean() })
    .meta({ description: "UI hints only; the server re-checks every request" }),
  history: z.array(
    z.discriminatedUnion("type", [
      z.strictObject({ type: z.literal("created"), at: instant }),
      z.strictObject({ type: z.literal("rescheduled"), at: instant, from: timeRange, to: timeRange }),
      z.strictObject({ type: z.literal("cancelled"), at: instant, by: z.enum(["client", "admin"]) }),
    ]),
  ),
  createdAt: instant,
};

export const clientBookingSchema = z
  .strictObject({
    ...bookingBase,
    notification: clientNotificationSchema.nullable().meta({ description: "null when booking emails are off on this server" }),
  })
  .meta({ id: "Booking" });

export const adminBookingSchema = z
  .strictObject({
    ...bookingBase,
    client: z.strictObject({ profileId: uuid, name: z.string().nullable(), email: z.string().nullable(), phone: z.string().nullable() }),
    notifications: z.array(adminNotificationSchema).meta({ description: "Client and studio results for every change, oldest first; empty when emails are off" }),
  })
  .meta({ id: "AdminBooking" });

// --- Admin schedule -------------------------------------------------------------

const interval = z.strictObject({ start: localTime, end: localTime });
export const scheduleExceptionViewSchema = z
  .strictObject({ date: localDate, closed: z.boolean(), intervals: z.array(interval) })
  .meta({ id: "ScheduleException" });

export const scheduleViewSchema = z
  .strictObject({
    timeZone: z.literal("Europe/Paris"),
    weekly: z.array(z.strictObject({ weekday: z.int().min(1).max(7).meta({ description: "ISO weekday, 1 = Monday … 7 = Sunday" }), start: localTime, end: localTime })),
    exceptions: z.array(scheduleExceptionViewSchema).meta({ description: "Exceptions from today on" }),
  })
  .meta({ id: "Schedule" });
