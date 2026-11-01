import { z } from "zod";
import { MARKETING_CONSENT_TEXT_VERSION } from "../modules/marketing/consent.js";
import { subscribeSchema } from "../modules/marketing/marketing.routes.js";
import { actionTokenSchema } from "../modules/email/schema/email.schema.js";
import { adminCancelSchema, createBookingSchema, rescheduleBookingSchema } from "../modules/bookings/booking.schema.js";
import { ownSubscriptionSchema, syncSchema } from "../modules/profiles/profile.routes.js";
import { updateOwnProfileSchema } from "../modules/profiles/profile.schema.js";
import { scheduleExceptionSchema, weeklyScheduleSchema } from "../modules/schedule/schedule.schema.js";
import { DEFAULT_BOOKING_RULES } from "../modules/schedule/booking-rules.js";
import {
  adminBookingSchema,
  adminNotificationSchema,
  availabilitySchema,
  clientBookingSchema,
  clientNotificationSchema,
  errorSchema,
  liveSchema,
  marketingStatusSchema,
  notReadySchema,
  ownSubscriptionRequestedSchema,
  profileViewSchema,
  publicServiceSchema,
  readySchema,
  scheduleExceptionViewSchema,
  scheduleViewSchema,
  syncResponseSchema,
} from "./schemas.js";

/**
 * OpenAPI 3.1 description of the HTTP API (served at /openapi.json when
 * ENABLE_API_DOCS=true). Built from the code only: request bodies come from
 * the validation schemas of the modules, responses from ./schemas.ts. Pure:
 * no database, Firebase or Brevo access. Invented example data only.
 */

type Json = unknown;
type Method = "get" | "post" | "put" | "patch" | "delete";
type Operation = {
  operationId: string;
  tags: string[];
  summary: string;
  description: string;
  /** [] = public; otherwise the Firebase ID token. Always explicit. */
  security: Record<string, string[]>[];
  parameters?: Json[];
  requestBody?: Json;
  responses: Record<string, Json>;
};
export type OpenApiDocument = {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: { url: string; description: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Partial<Record<Method, Operation>>>;
  components: { securitySchemes: Record<string, Json>; schemas: Record<string, Json> };
};

const SECURITY_SCHEME = "firebaseIdToken";
const PUBLIC: Record<string, string[]>[] = [];
const PROTECTED: Record<string, string[]>[] = [{ [SECURITY_SCHEME]: [] }];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SAFE_INTEGER_BOUNDS = new Set([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);

/**
 * Readable JSON Schema: without the `$schema`/`$id` keywords, the generated
 * regex next to a `format` (uuid, date, date-time) that already says the
 * same, and the ±2^53 bounds Zod adds to every integer. Property names
 * (e.g. a property called `id`) are kept: only keywords are dropped.
 */
const clean = (value: unknown, isPropertyMap = false): Json => {
  if (Array.isArray(value)) {
    return value.map((item) => clean(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const result: Record<string, Json> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isPropertyMap) {
      if (key === "$schema" || key === "$id") {
        continue;
      }
      if (key === "pattern" && (value.format === "uuid" || value.format === "date-time" || value.format === "date")) {
        continue;
      }
      if ((key === "minimum" || key === "maximum") && typeof child === "number" && SAFE_INTEGER_BOUNDS.has(child)) {
        continue;
      }
    }
    result[key] = clean(child, !isPropertyMap && (key === "properties" || key === "$defs" || key === "patternProperties"));
  }
  return result;
};

/** Request body schema from a module's validation schema (input side; refinements are described in text). */
const input = (schema: z.ZodType): Json => clean(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));

/**
 * Response schemas (./schemas.ts) carry `.meta({ id })` and become
 * components/schemas; nested schemas without an id are inlined with their
 * descriptions. Only the ids of this module are taken from the registry.
 */
const COMPONENT_SCHEMAS = {
  Error: errorSchema,
  Service: publicServiceSchema,
  Availability: availabilitySchema,
  MarketingStatus: marketingStatusSchema,
  ProfileView: profileViewSchema,
  SyncResponse: syncResponseSchema,
  OwnSubscriptionRequested: ownSubscriptionRequestedSchema,
  ClientNotification: clientNotificationSchema,
  AdminNotification: adminNotificationSchema,
  Booking: clientBookingSchema,
  AdminBooking: adminBookingSchema,
  Schedule: scheduleViewSchema,
  ScheduleException: scheduleExceptionViewSchema,
  Live: liveSchema,
  Ready: readySchema,
  NotReady: notReadySchema,
} satisfies Record<string, z.ZodType>;

const responseComponents = (): Record<string, Json> => {
  const converted = z.toJSONSchema(z.globalRegistry, { io: "output", uri: (id) => `#/components/schemas/${id}` });
  const schemas: Record<string, Json> = {};
  for (const id of Object.keys(COMPONENT_SCHEMAS)) {
    const schema = converted.schemas[id];
    if (schema === undefined) {
      throw new Error(`OpenAPI: response schema ${id} is not registered`);
    }
    schemas[id] = clean(schema);
  }
  return schemas;
};

const ref = (id: string): Json => ({ $ref: `#/components/schemas/${id}` });
const object = (properties: Record<string, Json>, required: string[] = Object.keys(properties)): Json => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const json = (schema: Json, example?: Json): Json => ({
  "application/json": example === undefined ? { schema } : { schema, example },
});
const ok = (description: string, schema: Json, example?: Json, headers?: Record<string, Json>): Json => ({
  description,
  ...(headers === undefined ? {} : { headers }),
  content: json(schema, example),
});

type ErrorExample = { message: string; code: string } & Record<string, Json>;
/** One error status with the fixed codes it can carry (examples keyed by code). */
const errors = (description: string, examples: ErrorExample[], retryAfter = false): Json => ({
  description,
  ...(retryAfter
    ? { headers: { "Retry-After": { description: "Seconds to wait before retrying (same as retryAfterSeconds)", schema: { type: "integer" } } } }
    : {}),
  content: {
    "application/json": {
      schema: ref("Error"),
      examples: Object.fromEntries(examples.map((example) => [example.code, { value: example }])),
    },
  },
});

const validation = (field = "startsAt"): ErrorExample => ({
  message: "Validation failed",
  code: "VALIDATION_FAILED",
  errors: [{ field: [field], message: "Invalid input" }],
});
const INVALID_JSON: ErrorExample = { message: "Malformed JSON request body", code: "INVALID_JSON" };

/** Errors of every operation that needs the Firebase ID token. */
const authErrors = (): Record<string, Json> => ({
  "401": errors("No, invalid, expired or revoked ID token", [
    { message: "Authentication required", code: "AUTH_REQUIRED" },
    { message: "Invalid ID token", code: "INVALID_TOKEN" },
    { message: "ID token expired; refresh it and retry", code: "TOKEN_EXPIRED" },
    { message: "Session revoked; sign in again", code: "SESSION_REVOKED" },
  ]),
  "403": errors("Firebase account disabled", [{ message: "Account disabled", code: "ACCOUNT_DISABLED" }]),
  "503": errors(
    "Firebase cannot be reached to verify the token",
    [{ message: "Authentication is temporarily unavailable; retry later", code: "AUTH_UNAVAILABLE", retryAfterSeconds: 5 }],
    true,
  ),
});

/** Merges extra error examples into a status that authErrors() already has. */
const withAuth = (responses: Record<string, Json>, extra: Record<string, ErrorExample[]> = {}, retryAfter: string[] = []): Record<string, Json> => {
  const base = authErrors();
  const authExamples: Record<string, ErrorExample[]> = {
    "403": [{ message: "Account disabled", code: "ACCOUNT_DISABLED" }],
    "503": [{ message: "Authentication is temporarily unavailable; retry later", code: "AUTH_UNAVAILABLE", retryAfterSeconds: 5 }],
  };
  const merged: Record<string, Json> = { ...base, ...responses };
  for (const [status, examples] of Object.entries(extra)) {
    merged[status] = errors(
      status === "503" ? "Temporarily unavailable" : status === "403" ? "Not allowed" : "Error",
      [...(authExamples[status] ?? []), ...examples],
      status === "503" || retryAfter.includes(status),
    );
  }
  return merged;
};

const pathParam = (name: string, description: string, schema: Json, example: string): Json => ({
  name,
  in: "path",
  required: true,
  description,
  schema,
  example,
});
const queryParam = (name: string, description: string, required: boolean, example: string): Json => ({
  name,
  in: "query",
  required,
  description,
  schema: { type: "string", format: "date" },
  example,
});

const SERVICE_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const BOOKING_ID = "8f0c2b1e-4a5d-4c6e-9f7a-1b2c3d4e5f60";
const PROFILE_ID = "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

const serviceIdParam = pathParam("serviceId", "Service id (from GET /api/services)", { type: "string", format: "uuid" }, SERVICE_ID);
const bookingIdParam = pathParam("bookingId", "Booking id", { type: "string", format: "uuid" }, BOOKING_ID);
const dateParam = pathParam("date", "Local date of the studio, YYYY-MM-DD", { type: "string", format: "date" }, "2027-03-08");

const SERVICE_EXAMPLE = {
  id: SERVICE_ID,
  name: "Massage example",
  durationMinutes: 60,
  priceCents: 8500,
  effectivePriceCents: 8500,
  salePriceCents: null,
  saleEndsAt: null,
  currency: "EUR",
};
const BOOKING_EXAMPLE = {
  id: BOOKING_ID,
  status: "confirmed",
  phase: "upcoming",
  timeZone: "Europe/Paris",
  startsAt: "2027-03-02T08:00:00.000Z",
  endsAt: "2027-03-02T09:00:00.000Z",
  service: { id: SERVICE_ID, name: "Massage example", durationMinutes: 60, priceCents: 6900, currency: "EUR" },
  payment: "on_site",
  cancellation: null,
  allowedActions: { reschedule: true, cancel: true },
  history: [{ type: "created", at: "2027-03-01T07:00:00.000Z" }],
  createdAt: "2027-03-01T07:00:00.000Z",
  notification: { event: "created", status: "accepted", reason: null },
};
const ADMIN_BOOKING_EXAMPLE = {
  ...Object.fromEntries(Object.entries(BOOKING_EXAMPLE).filter(([key]) => key !== "notification")),
  allowedActions: { reschedule: false, cancel: true },
  client: { profileId: PROFILE_ID, name: "Anna Example", email: "anna@example.invalid", phone: "+33612345678" },
  notifications: [
    {
      event: "created",
      occurredAt: "2027-03-01T07:00:00.000Z",
      client: { status: "accepted", reason: null, attempts: 1, lastAttemptAt: "2027-03-01T07:00:01.000Z", acceptedAt: "2027-03-01T07:00:01.000Z" },
      studio: { status: "failed", reason: "temporary_errors", attempts: 3, lastAttemptAt: "2027-03-01T07:06:40.000Z", acceptedAt: null },
    },
  ],
};
const PROFILE_EXAMPLE = {
  profile: {
    id: PROFILE_ID,
    role: "client",
    authState: "registered",
    name: "Anna Example",
    email: "anna@example.invalid",
    emailVerified: true,
    phone: "+33612345678",
    signInProvider: "password",
    createdAt: "2027-02-20T10:00:00.000Z",
    updatedAt: "2027-02-20T10:05:00.000Z",
  },
  bookingReadiness: { ready: true, blockers: [] },
  marketing: {
    subscribed: false,
    pendingConfirmation: false,
    consentGivenAt: null,
    consentSource: null,
    consentTextVersion: null,
    unsubscribedAt: null,
  },
};
const SCHEDULE_EXAMPLE = {
  timeZone: "Europe/Paris",
  weekly: [
    { weekday: 1, start: "09:00", end: "13:00" },
    { weekday: 1, start: "14:00", end: "20:30" },
  ],
  exceptions: [{ date: "2027-03-08", closed: true, intervals: [] }],
};

const rules = DEFAULT_BOOKING_RULES;
const hours = (minutes: number) => `${String(minutes / 60)} h`;
const clock = (minuteOfDay: number) => `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;

const DESCRIPTION = `
Booking API of the massage studio (modular monolith, one application). All payloads are JSON.

## Try it out runs real operations
"Try it out" sends real requests to **this server**, in the environment you opened the page from: bookings are created, profiles and schedules change, emails can be sent. Use test accounts and test data.

## Sign-in happens in Firebase, not in this API
Google, email/password and anonymous (guest) sign-in are done by the frontend with the **Firebase Authentication client SDK**. This API has no sign-in, sign-up or password routes. It only receives the resulting **Firebase ID token** in \`Authorization: Bearer <token>\` and verifies it on every request (signature, project, expiry, revocation, disabled account).

To try protected operations: obtain an ID token from your own Firebase session in the frontend (\`await auth.currentUser.getIdToken()\`), click **Authorize** and paste it. ID tokens expire after about an hour. The page does not keep the token after a reload. Never paste tokens of other people.

## Who may do what
- **Public** (no token): catalogue, availability, health, the marketing subscription form and its email links. A token sent to a public route is ignored.
- **Guest**: Firebase anonymous session. Has a profile (\`POST /api/me/sync\`), sees and cancels own bookings, but **cannot book** (\`BOOKING_NOT_READY\` with \`anonymous_session\`).
- **Registered client**: role \`client\`, not anonymous. To book or reschedule, the email must be verified and the profile needs a name and a phone (\`bookingReadiness.blockers\` lists what is missing).
- **Administrator**: role \`admin\` (assigned by the owner with a command, never through the API), not anonymous, **verified email**. Only administrators use \`/api/admin\`; they do not book for themselves.

Routes under \`/api/me\`, \`/api/bookings\` and \`/api/admin\` exist only when Firebase is configured on the server; \`/api/marketing\` and \`POST /api/me/marketing/subscription\` only when marketing is enabled (otherwise \`404 NOT_FOUND\`).

## Money
Integer **euro cents**, currency \`EUR\` (8500 = 85,00 €).
- \`priceCents\` — regular price; \`effectivePriceCents\` — price of a booking created **now**.
- \`salePriceCents\` and \`saleEndsAt\` — only while a sale is active (server time strictly before \`saleEndsAt\`), otherwise both \`null\`. Exactly at \`saleEndsAt\` the regular price applies.
- The price is decided by the server at the **moment the booking is created** (not the session date) and stored in the booking (\`service.priceCents\` of the booking). Rescheduling, the end of a sale and catalogue changes never change it. Prices in requests are not accepted.

## Time
- Requests: instants in ISO 8601 **with an offset** (\`2027-03-02T08:00:00Z\` or \`2027-03-02T09:00:00+01:00\`). Responses: UTC (\`…Z\`).
- Business time zone: **${rules.timeZone}** (summer and winter time). Local dates are \`YYYY-MM-DD\`, local times \`HH:MM\`.
- One minimum break of **${String(rules.breakMinutes)} minutes** between two sessions.
- **Grid of starts:** every ${String(rules.slotStepMinutes)} minutes from the start of a free stretch: the start of a working interval, or the end of the previous session plus the break. The session must fit in the working interval (the break after the last session need not).
- **Latest start ${clock(rules.latestStartMinuteOfDay)}** local time (inclusive).
- A new start (booking or rescheduling) must be at least **${hours(rules.minLeadMinutes)}** from now and not later than the end of the local day **today + ${String(rules.horizonDays)} days**.
- **Rescheduling** by the client only while **more than ${hours(rules.rescheduleCutoffMinutes)}** remain before the current start; the service and the agreed price stay.
- **Cancelling** (client or admin) only **before the start**.

## Idempotency-Key
Required on \`POST /api/bookings\` only: 8–128 characters \`[A-Za-z0-9_-]\` (a UUID fits), one per booking attempt of the client. A repeat with the same key and the same request returns the original booking (\`200\`, header \`Idempotent-Replayed: true\`) with its original price, even after a sale has ended; no second booking or event. The same key with a different request is \`422 IDEMPOTENCY_KEY_REUSED\`. Rescheduling and cancelling are idempotent without a key: a repeat answers \`changed: false\`.

## Email status
Booking emails are separate from the booking status. \`accepted\` means **accepted by the email provider for sending, not delivered to the mailbox**. A failed email never cancels or changes the booking.

## retryAfterSeconds
- In errors (also the \`Retry-After\` header): \`AUTH_UNAVAILABLE\` (5 s), \`CALENDAR_BUSY\` (2 s), \`CONFIRMATION_EMAIL_NOT_SENT\` (always 60 s). After a provider rate limit (429) new confirmation emails for that address are blocked longer (until the provider's Retry-After, or 10 minutes): a retry after 60 s sends nothing and answers \`no_action\` (for the signed-in owner with the real \`retryAfterSeconds\`).
- In \`POST /api/me/marketing/subscription\` with \`outcome: "no_action"\`: seconds until "send again" may send a new confirmation email (10-minute interval after a sent email; after a provider rate limit, until the provider's Retry-After).

## Errors
\`{ "message": "…", "code": "…" }\` plus fields of some codes (\`errors\`, \`blockers\`, \`reason\`, \`retryAfterSeconds\`, \`currentConsentTextVersion\`, \`conflicts\`). Unknown fields in request bodies are rejected (\`400 VALIDATION_FAILED\`). Malformed JSON: \`400 INVALID_JSON\`; body over 16 kB: \`413 PAYLOAD_TOO_LARGE\`; unknown route: \`404 NOT_FOUND\`.
`.trim();

const op = (operation: Operation): Operation => operation;

const paths = (): OpenApiDocument["paths"] => ({
  "/health/live": {
    get: op({
      operationId: "getLiveness",
      tags: ["Health"],
      summary: "Liveness",
      description: "The process is up and serving HTTP. No database, Firebase or email access. Public.",
      security: PUBLIC,
      responses: { "200": ok("Alive", ref("Live"), { status: "ok" }) },
    }),
  },
  "/health/ready": {
    get: op({
      operationId: "getReadiness",
      tags: ["Health"],
      summary: "Readiness",
      description: "Ready to serve: not shutting down and the database answers `SELECT 1` within the readiness timeout. Public. Do not point external uptime monitors here: it wakes the database (use /health/live).",
      security: PUBLIC,
      responses: {
        "200": ok("Ready", ref("Ready"), { status: "ready", version: "0123456789abcdef0123456789abcdef01234567" }),
        "503": ok("Not ready", ref("NotReady"), { status: "unavailable", reason: "database_unavailable" }),
      },
    }),
  },

  "/api/services": {
    get: op({
      operationId: "listServices",
      tags: ["Catalogue"],
      summary: "List bookable services",
      description: "Fixed catalogue; only bookable services. Photos, long descriptions and card design live in the frontend, keyed by `id`. Prices for a booking created now: see Money. `Cache-Control: no-store`. Public.",
      security: PUBLIC,
      responses: {
        "200": ok("Bookable services", object({ services: { type: "array", items: ref("Service") } }), { services: [SERVICE_EXAMPLE] }),
      },
    }),
  },
  "/api/services/{serviceId}": {
    get: op({
      operationId: "getService",
      tags: ["Catalogue"],
      summary: "One bookable service",
      description: "Same fields as in the list. A service that is not bookable is not found. `Cache-Control: no-store`. Public.",
      security: PUBLIC,
      parameters: [serviceIdParam],
      responses: {
        "200": ok("The service", object({ service: ref("Service") }), {
          service: { ...SERVICE_EXAMPLE, effectivePriceCents: 6900, salePriceCents: 6900, saleEndsAt: "2026-11-30T23:00:00.000Z" },
        }),
        "404": errors("Unknown or not bookable", [{ message: "Service not found", code: "SERVICE_NOT_FOUND" }]),
      },
    }),
  },
  "/api/services/{serviceId}/availability": {
    get: op({
      operationId: "getAvailability",
      tags: ["Availability"],
      summary: "Free starts of a service",
      description: `Free starts per local date (${rules.timeZone}) for the service's duration, by the time rules (grid, break, latest start, ${hours(rules.minLeadMinutes)} lead, ${String(rules.horizonDays)}-day horizon). The range is clipped to [today, today + ${String(rules.horizonDays)}]. Contains times only, nothing about other clients. Public.`,
      security: PUBLIC,
      parameters: [
        serviceIdParam,
        queryParam("from", "First local date (default: today)", false, "2027-03-02"),
        queryParam("to", "Last local date (default: the end of the horizon); not before from", false, "2027-03-03"),
      ],
      responses: {
        "200": ok("Free starts", ref("Availability"), {
          serviceId: SERVICE_ID,
          durationMinutes: 60,
          timeZone: "Europe/Paris",
          from: "2027-03-02",
          to: "2027-03-03",
          days: [
            { date: "2027-03-02", slots: [{ startsAt: "2027-03-02T08:00:00.000Z", endsAt: "2027-03-02T09:00:00.000Z" }] },
            { date: "2027-03-03", slots: [] },
          ],
        }),
        "400": errors("Invalid dates", [validation("to")]),
        "404": errors("Unknown or not bookable service", [{ message: "Service not found", code: "SERVICE_NOT_FOUND" }]),
      },
    }),
  },

  "/api/me/sync": {
    post: op({
      operationId: "syncProfile",
      tags: ["Profile"],
      summary: "Create or refresh the caller's profile from the ID token",
      description:
        "Call after every sign-in, after linking an anonymous session to Google or email/password, after email verification (with a forced token refresh) and after an email change. Idempotent and safe in parallel; writes only when the token changes something. The response already contains the profile (no need for GET /api/me afterwards). Optional sign-up checkbox: `marketingOptIn: true` with the consent text version shown (`" +
        MARKETING_CONSENT_TEXT_VERSION +
        "`) starts the double opt-in at most once per address; the result is in `marketingOptIn` and never fails the sync. Any signed-in user, guests included.",
      security: PROTECTED,
      requestBody: {
        required: false,
        description: "Optional. `marketingConsentTextVersion` is required when `marketingOptIn` is true.",
        content: json(input(syncSchema), { marketingOptIn: true, marketingConsentTextVersion: MARKETING_CONSENT_TEXT_VERSION }),
      },
      responses: withAuth(
        {
          "200": ok("The profile", ref("SyncResponse"), {
            ...PROFILE_EXAMPLE,
            marketingOptIn: { outcome: "confirmation_sent", currentConsentTextVersion: MARKETING_CONSENT_TEXT_VERSION },
          }),
          "400": errors("Invalid body", [validation("marketingConsentTextVersion"), INVALID_JSON]),
        },
      ),
    }),
  },
  "/api/me": {
    get: op({
      operationId: "getProfile",
      tags: ["Profile"],
      summary: "The caller's profile",
      description: "Read only. Any signed-in user. `marketing` is null unless the email is verified.",
      security: PROTECTED,
      responses: withAuth(
        {
          "200": ok("The profile", ref("ProfileView"), PROFILE_EXAMPLE),
          "404": errors("No profile yet", [{ message: "Profile not found; call POST /api/me/sync first", code: "PROFILE_NOT_FOUND" }]),
        },
      ),
    }),
    patch: op({
      operationId: "updateProfile",
      tags: ["Profile"],
      summary: "Change own name and phone",
      description:
        "At least one of `name`, `phone`; `null` clears a field. Phone in international or French format, stored as E.164. Email, role and verification are not accepted (email changes go through Firebase and reach the profile with the next sync). Any signed-in user.",
      security: PROTECTED,
      requestBody: { required: true, content: json(input(updateOwnProfileSchema), { name: "Anna Example", phone: "+33 6 12 34 56 78" }) },
      responses: withAuth(
        {
          "200": ok("The updated profile", ref("ProfileView"), PROFILE_EXAMPLE),
          "400": errors("Invalid body", [validation("phone"), INVALID_JSON]),
          "404": errors("No profile yet", [{ message: "Profile not found; call POST /api/me/sync first", code: "PROFILE_NOT_FOUND" }]),
        },
      ),
    }),
  },
  "/api/me/marketing/subscription": {
    post: op({
      operationId: "requestOwnSubscription",
      tags: ["Marketing"],
      summary: "Subscribe to offers / send the confirmation again",
      description:
        "Explicit (re-)subscription of the signed-in user's email, also after unsubscribing. Double opt-in: subscribed only after the emailed link (POST /api/marketing/subscriptions/confirm). At most one confirmation email per address per 10 minutes: inside that interval (or while a provider rate limit lasts) the answer is `no_action` with `retryAfterSeconds`; `no_action` without it means already subscribed. When the outcome of sending is unknown (timeout), `no_action` too: the email may have been sent. Registered users only (not guests); only when marketing is enabled.",
      security: PROTECTED,
      requestBody: { required: true, content: json(input(ownSubscriptionSchema), { consentTextVersion: MARKETING_CONSENT_TEXT_VERSION }) },
      responses: withAuth(
        {
          "202": ok("Requested", ref("OwnSubscriptionRequested"), { outcome: "no_action", retryAfterSeconds: 412 }),
          "400": errors("Invalid body", [validation("consentTextVersion"), INVALID_JSON]),
          "404": errors("Marketing is not enabled", [{ message: "Not found", code: "NOT_FOUND" }]),
          "409": errors("The consent text shown is outdated", [
            { message: "The consent text shown is outdated; reload and show the current one", code: "CONSENT_TEXT_OUTDATED", currentConsentTextVersion: MARKETING_CONSENT_TEXT_VERSION },
          ]),
        },
        {
          "403": [{ message: "A registered account with an email is required; guests use the subscription form", code: "REGISTERED_ACCOUNT_REQUIRED" }],
          "503": [
            { message: "The confirmation email could not be sent; nothing was changed, please retry later", code: "CONFIRMATION_EMAIL_NOT_SENT", retryAfterSeconds: 60 },
          ],
        },
      ),
    }),
    delete: op({
      operationId: "unsubscribeOwn",
      tags: ["Marketing"],
      summary: "Unsubscribe from offers",
      description: "Marketing only; booking emails are not affected. Works even when marketing emails are switched off. Idempotent. Requires a verified email.",
      security: PROTECTED,
      responses: withAuth(
        { "200": ok("The profile after unsubscribing", ref("ProfileView"), PROFILE_EXAMPLE) },
        { "403": [{ message: "Verify your email first", code: "EMAIL_NOT_VERIFIED" }] },
      ),
    }),
  },
  "/api/me/sessions/revoke": {
    post: op({
      operationId: "revokeSessions",
      tags: ["Profile"],
      summary: "Sign out everywhere",
      description: "Revokes the caller's Firebase refresh tokens; ID tokens issued before now are rejected from the next request on (`401 SESSION_REVOKED`). Any signed-in user.",
      security: PROTECTED,
      responses: withAuth({ "204": { description: "Revoked" } }),
    }),
  },

  "/api/marketing/subscriptions": {
    post: op({
      operationId: "requestSubscription",
      tags: ["Marketing"],
      summary: "Subscription form (no account needed)",
      description:
        "Starts the double opt-in for an address. The answer is the same for new, pending, recently emailed and already subscribed addresses (reveals nothing). At most one confirmation email per address per 10 minutes; after a provider rate limit, none until its Retry-After. Public; only when marketing is enabled.",
      security: PUBLIC,
      requestBody: { required: true, content: json(input(subscribeSchema), { email: "anna@example.invalid", consentTextVersion: MARKETING_CONSENT_TEXT_VERSION }) },
      responses: {
        "202": ok("Requested", object({ code: { const: "SUBSCRIPTION_REQUESTED" }, message: { type: "string" } }), {
          code: "SUBSCRIPTION_REQUESTED",
          message: "If this address can receive email and is not subscribed yet, a confirmation link has been sent to it.",
        }),
        "400": errors("Invalid body", [validation("email"), INVALID_JSON]),
        "409": errors("The consent text shown is outdated", [
          { message: "The consent text shown is outdated; reload and show the current one", code: "CONSENT_TEXT_OUTDATED", currentConsentTextVersion: MARKETING_CONSENT_TEXT_VERSION },
        ]),
        "503": errors(
          "The provider certainly did not accept the email. retryAfterSeconds is always 60; after a provider rate limit the address stays blocked longer and a retry answers 202 without sending",
          [{ message: "The confirmation email could not be sent; nothing was changed, please retry later", code: "CONFIRMATION_EMAIL_NOT_SENT", retryAfterSeconds: 60 }],
          true,
        ),
      },
    }),
  },
  "/api/marketing/subscriptions/confirm": {
    post: op({
      operationId: "confirmSubscription",
      tags: ["Marketing"],
      summary: "Confirm the subscription (link from the email)",
      description: "The token comes from the confirmation link (`/marketing/confirm?token=…` of the frontend). Single use; a later link replaces earlier ones. Public; only when marketing is enabled.",
      security: PUBLIC,
      requestBody: { required: true, content: json(input(actionTokenSchema), { token: "<token from the emailed link>" }) },
      responses: {
        "200": ok("Subscribed", object({ code: { enum: ["SUBSCRIBED", "ALREADY_SUBSCRIBED"] }, message: { type: "string" } }), {
          code: "SUBSCRIBED",
          message: "Subscription to offers confirmed.",
        }),
        "400": errors("Invalid, expired, used or replaced link", [{ message: "Invalid or expired link", code: "INVALID_ACTION_TOKEN" }, validation("token")]),
      },
    }),
  },
  "/api/marketing/subscriptions/unsubscribe": {
    post: op({
      operationId: "unsubscribeByLink",
      tags: ["Marketing"],
      summary: "Unsubscribe (link from an email)",
      description: "The token comes from the unsubscribe link of a marketing email. Same answer whether or not the subscription exists. Booking emails are not affected. Public; only when marketing is enabled.",
      security: PUBLIC,
      requestBody: { required: true, content: json(input(actionTokenSchema), { token: "<token from the emailed link>" }) },
      responses: {
        "200": ok("Unsubscribed", object({ code: { const: "UNSUBSCRIBED" }, message: { type: "string" } }), {
          code: "UNSUBSCRIBED",
          message: "You will no longer receive marketing emails. Emails about your account and bookings are not affected.",
        }),
        "400": errors("Invalid link", [{ message: "Invalid or expired link", code: "INVALID_ACTION_TOKEN" }, validation("token")]),
      },
    }),
  },

  "/api/bookings": {
    post: op({
      operationId: "createBooking",
      tags: ["Bookings"],
      summary: "Book a service",
      description:
        "Confirmed at once. The server computes the end, duration and price (the sale price if a sale is active at this moment), under the calendar lock. Only a booking-ready client (registered, verified email, name, phone; not an admin). Requires `Idempotency-Key` (see Idempotency-Key). The response does not wait for or promise an email; `notification` shows its state.",
      security: PROTECTED,
      parameters: [
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description: "8–128 characters [A-Za-z0-9_-]; one per booking attempt. Repeat it to retry safely.",
          schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
          example: "3f0e1c9a-6f5b-4c1e-9d7a-2b8c4e6f1a20",
        },
      ],
      requestBody: { required: true, content: json(input(createBookingSchema), { serviceId: SERVICE_ID, startsAt: "2027-03-02T09:00:00+01:00" }) },
      responses: withAuth(
        {
          "201": ok("Booked", object({ booking: ref("Booking") }), { booking: { ...BOOKING_EXAMPLE, notification: { event: "created", status: "pending", reason: null } } }),
          "200": ok("Repeat of an earlier request with the same key: the original booking", object({ booking: ref("Booking") }), { booking: BOOKING_EXAMPLE }, {
            "Idempotent-Replayed": { description: "true", schema: { type: "string", const: "true" } },
          }),
          "400": errors("Invalid body or key", [
            validation("startsAt"),
            { message: "Idempotency-Key header is required", code: "IDEMPOTENCY_KEY_REQUIRED" },
            { message: "Idempotency-Key must be 8–128 characters of A–Z, a–z, 0–9, _ or -", code: "IDEMPOTENCY_KEY_INVALID" },
            INVALID_JSON,
          ]),
          "404": errors("Unknown service", [{ message: "Service not found", code: "SERVICE_NOT_FOUND" }]),
          "409": errors("Not possible", [
            { message: "The requested time is not available", code: "SLOT_UNAVAILABLE", reason: "taken" },
            { message: "This service is no longer available for booking", code: "SERVICE_NOT_BOOKABLE" },
          ]),
          "422": errors("Key reused for another request", [{ message: "This Idempotency-Key was already used for a different request", code: "IDEMPOTENCY_KEY_REUSED" }]),
        },
        {
          "403": [{ message: "Profile is not ready for booking", code: "BOOKING_NOT_READY", blockers: ["email_not_verified", "phone_missing"] }],
          "503": [{ message: "The calendar is busy; retry shortly", code: "CALENDAR_BUSY", retryAfterSeconds: 2 }],
        },
      ),
    }),
    get: op({
      operationId: "listOwnBookings",
      tags: ["Bookings"],
      summary: "The caller's bookings",
      description: "Own bookings only, cancelled and past included. Any signed-in user (guests see their own).",
      security: PROTECTED,
      responses: withAuth({ "200": ok("Own bookings", object({ bookings: { type: "array", items: ref("Booking") } }), { bookings: [BOOKING_EXAMPLE] }) }),
    }),
  },
  "/api/bookings/{bookingId}": {
    get: op({
      operationId: "getOwnBooking",
      tags: ["Bookings"],
      summary: "One own booking",
      description: "With history and the client's email state. Someone else's booking is 404 (never 403). Any signed-in user.",
      security: PROTECTED,
      parameters: [bookingIdParam],
      responses: withAuth({
        "200": ok("The booking", object({ booking: ref("Booking") }), { booking: BOOKING_EXAMPLE }),
        "404": errors("Not found (or not yours)", [{ message: "Booking not found", code: "BOOKING_NOT_FOUND" }]),
      }),
    }),
  },
  "/api/bookings/{bookingId}/reschedule": {
    post: op({
      operationId: "rescheduleBooking",
      tags: ["Bookings"],
      summary: "Move an own booking",
      description: `Only the owning, booking-ready client, while more than ${hours(rules.rescheduleCutoffMinutes)} remain before the current start; the new start follows the time rules. Service and agreed price stay. Atomic: if the new time is not free nothing changes. Repeating a successful request answers \`changed: false\`.`,
      security: PROTECTED,
      parameters: [bookingIdParam],
      requestBody: { required: true, content: json(input(rescheduleBookingSchema), { startsAt: "2027-03-03T10:00:00+01:00" }) },
      responses: withAuth(
        {
          "200": ok("Moved (or already at that time)", object({ booking: ref("Booking"), changed: { type: "boolean" } }), { booking: BOOKING_EXAMPLE, changed: true }),
          "400": errors("Invalid body", [validation("startsAt"), INVALID_JSON]),
          "404": errors("Not found (or not yours)", [{ message: "Booking not found", code: "BOOKING_NOT_FOUND" }]),
          "409": errors("Not possible", [
            { message: "A booking can be moved only while more than 12 hours remain before it", code: "RESCHEDULE_WINDOW_CLOSED" },
            { message: "The booking is cancelled", code: "BOOKING_NOT_ACTIVE" },
            { message: "The requested time is not available", code: "SLOT_UNAVAILABLE", reason: "too_soon" },
          ]),
        },
        {
          "403": [{ message: "Profile is not ready for booking", code: "BOOKING_NOT_READY", blockers: ["phone_missing"] }],
          "503": [{ message: "The calendar is busy; retry shortly", code: "CALENDAR_BUSY", retryAfterSeconds: 2 }],
        },
      ),
    }),
  },
  "/api/bookings/{bookingId}/cancel": {
    post: op({
      operationId: "cancelOwnBooking",
      tags: ["Bookings"],
      summary: "Cancel an own booking",
      description: "Any time before the start. Body empty or `{}`. Frees the time; the booking stays in the history. A repeat answers `changed: false`. Owner only (guests included).",
      security: PROTECTED,
      parameters: [bookingIdParam],
      requestBody: { required: false, content: json({ type: "object", additionalProperties: false }, {}) },
      responses: withAuth(
        {
          "200": ok("Cancelled (or already)", object({ booking: ref("Booking"), changed: { type: "boolean" } }), {
            booking: { ...BOOKING_EXAMPLE, status: "cancelled", phase: "cancelled" },
            changed: true,
          }),
          "400": errors("Invalid body", [validation("x"), INVALID_JSON]),
          "404": errors("Not found (or not yours)", [{ message: "Booking not found", code: "BOOKING_NOT_FOUND" }]),
          "409": errors("Already started", [{ message: "A booking can be cancelled only before it starts", code: "CANCELLATION_WINDOW_CLOSED" }]),
        },
        { "503": [{ message: "The calendar is busy; retry shortly", code: "CALENDAR_BUSY", retryAfterSeconds: 2 }] },
      ),
    }),
  },

  "/api/admin/schedule": {
    get: op({
      operationId: "getSchedule",
      tags: ["Admin: schedule"],
      summary: "Weekly schedule and exceptions",
      description: "Weekly working intervals and every date exception from today on. Verified administrator only.",
      security: PROTECTED,
      responses: withAuth({ "200": ok("The schedule", ref("Schedule"), SCHEDULE_EXAMPLE) }, adminOnly()),
    }),
  },
  "/api/admin/schedule/weekly": {
    put: op({
      operationId: "replaceWeeklySchedule",
      tags: ["Admin: schedule"],
      summary: "Replace the whole weekly schedule",
      description:
        "All weekly intervals at once (days without intervals are days off). Per weekday at most 6 intervals that must not overlap; start before end. Refused if an active booking would fall outside the working hours (`409 SCHEDULE_CONFLICT` lists them). Dates with an exception keep it. Verified administrator only.",
      security: PROTECTED,
      requestBody: { required: true, content: json(input(weeklyScheduleSchema), { intervals: SCHEDULE_EXAMPLE.weekly }) },
      responses: withAuth(
        {
          "200": ok("The new schedule", ref("Schedule"), SCHEDULE_EXAMPLE),
          "400": errors("Invalid body", [validation("intervals"), INVALID_JSON]),
          "409": errors("Active bookings would fall outside the working hours", [scheduleConflict()]),
        },
        { ...adminOnly(), "503": [{ message: "The calendar is busy; retry shortly", code: "CALENDAR_BUSY", retryAfterSeconds: 2 }] },
      ),
    }),
  },
  "/api/admin/schedule/exceptions": {
    get: op({
      operationId: "listScheduleExceptions",
      tags: ["Admin: schedule"],
      summary: "Date exceptions in a range",
      description: "Verified administrator only.",
      security: PROTECTED,
      parameters: [queryParam("from", "First date (default: today)", false, "2027-03-01"), queryParam("to", "Last date (default: no limit)", false, "2027-03-31")],
      responses: withAuth(
        {
          "200": ok("Exceptions", object({ timeZone: { const: "Europe/Paris" }, exceptions: { type: "array", items: ref("ScheduleException") } }), {
            timeZone: "Europe/Paris",
            exceptions: SCHEDULE_EXAMPLE.exceptions,
          }),
          "400": errors("Invalid dates", [validation("from")]),
        },
        adminOnly(),
      ),
    }),
  },
  "/api/admin/schedule/exceptions/{date}": {
    put: op({
      operationId: "setScheduleException",
      tags: ["Admin: schedule"],
      summary: "Set the hours of one date",
      description:
        "`{ \"closed\": true }` for a day off, or `{ \"intervals\": [...] }` (1–6, not overlapping) for own working hours that replace the weekly rule on that date. Refused if an active booking would fall outside (`409 SCHEDULE_CONFLICT`). Verified administrator only.",
      security: PROTECTED,
      parameters: [dateParam],
      requestBody: { required: true, content: json(input(scheduleExceptionSchema), { intervals: [{ start: "10:00", end: "14:00" }] }) },
      responses: withAuth(
        {
          "200": ok("The exception", ref("ScheduleException"), { date: "2027-03-08", closed: false, intervals: [{ start: "10:00", end: "14:00" }] }),
          "400": errors("Invalid date or body", [validation("date"), INVALID_JSON]),
          "409": errors("Active bookings would fall outside the working hours", [scheduleConflict()]),
        },
        { ...adminOnly(), "503": [{ message: "The calendar is busy; retry shortly", code: "CALENDAR_BUSY", retryAfterSeconds: 2 }] },
      ),
    }),
    delete: op({
      operationId: "removeScheduleException",
      tags: ["Admin: schedule"],
      summary: "Back to the weekly rule for one date",
      description: "Also checked for conflicts with active bookings. `removed: false` when there was no exception. Verified administrator only.",
      security: PROTECTED,
      parameters: [dateParam],
      responses: withAuth(
        {
          "200": ok("Removed", object({ date: { type: "string", format: "date" }, removed: { type: "boolean" } }), { date: "2027-03-08", removed: true }),
          "400": errors("Invalid date", [validation("date")]),
          "409": errors("Active bookings would fall outside the working hours", [scheduleConflict()]),
        },
        { ...adminOnly(), "503": [{ message: "The calendar is busy; retry shortly", code: "CALENDAR_BUSY", retryAfterSeconds: 2 }] },
      ),
    }),
  },
  "/api/admin/bookings": {
    get: op({
      operationId: "listBookingsOfDate",
      tags: ["Admin: bookings"],
      summary: "Bookings starting on a local date",
      description: "All statuses, with client contact data and email results for both recipients. Verified administrator only.",
      security: PROTECTED,
      parameters: [queryParam("date", "Local date (required)", true, "2027-03-02")],
      responses: withAuth(
        {
          "200": ok("Bookings of the date", object({ date: { type: "string", format: "date" }, timeZone: { const: "Europe/Paris" }, bookings: { type: "array", items: ref("AdminBooking") } }), {
            date: "2027-03-02",
            timeZone: "Europe/Paris",
            bookings: [ADMIN_BOOKING_EXAMPLE],
          }),
          "400": errors("Missing or invalid date", [validation("date")]),
        },
        adminOnly(),
      ),
    }),
  },
  "/api/admin/bookings/{bookingId}": {
    get: op({
      operationId: "getAnyBooking",
      tags: ["Admin: bookings"],
      summary: "Any booking",
      description: "With client data, history and email results. Verified administrator only.",
      security: PROTECTED,
      parameters: [bookingIdParam],
      responses: withAuth(
        {
          "200": ok("The booking", object({ booking: ref("AdminBooking") }), { booking: ADMIN_BOOKING_EXAMPLE }),
          "404": errors("Not found", [{ message: "Booking not found", code: "BOOKING_NOT_FOUND" }]),
        },
        adminOnly(),
      ),
    }),
  },
  "/api/admin/bookings/{bookingId}/cancel": {
    post: op({
      operationId: "cancelAnyBooking",
      tags: ["Admin: bookings"],
      summary: "Cancel a booking (studio)",
      description: "Before its start; the reason (optional, 1–500 characters) is shown to the client in the email. A repeat answers `changed: false`. Administrators cannot reschedule. Verified administrator only.",
      security: PROTECTED,
      parameters: [bookingIdParam],
      requestBody: { required: false, content: json(input(adminCancelSchema), { reason: "Fermeture exceptionnelle" }) },
      responses: withAuth(
        {
          "200": ok("Cancelled (or already)", object({ booking: ref("AdminBooking"), changed: { type: "boolean" } }), {
            booking: { ...ADMIN_BOOKING_EXAMPLE, status: "cancelled", phase: "cancelled" },
            changed: true,
          }),
          "400": errors("Invalid body", [validation("reason"), INVALID_JSON]),
          "404": errors("Not found", [{ message: "Booking not found", code: "BOOKING_NOT_FOUND" }]),
          "409": errors("Already started", [{ message: "A booking can be cancelled only before it starts", code: "CANCELLATION_WINDOW_CLOSED" }]),
        },
        { ...adminOnly(), "503": [{ message: "The calendar is busy; retry shortly", code: "CALENDAR_BUSY", retryAfterSeconds: 2 }] },
      ),
    }),
  },
});

function adminOnly(): Record<string, ErrorExample[]> {
  return { "403": [{ message: "Forbidden", code: "FORBIDDEN" }] };
}

function scheduleConflict(): ErrorExample {
  return {
    message: "The change would leave active bookings outside the working hours; resolve them first",
    code: "SCHEDULE_CONFLICT",
    conflicts: [{ bookingId: BOOKING_ID, startsAt: "2027-03-08T09:00:00.000Z", endsAt: "2027-03-08T10:00:00.000Z", serviceName: "Massage example" }],
  };
}

export const buildOpenApiDocument = (): OpenApiDocument => ({
  openapi: "3.1.0",
  info: { title: "Massage booking API", version: "1.0.0", description: DESCRIPTION },
  // Relative: Swagger UI sends "Try it out" requests to the origin it was opened from.
  servers: [{ url: "/", description: "This server (the origin of this page)" }],
  tags: [
    { name: "Health", description: "Liveness and readiness (public)" },
    { name: "Catalogue", description: "Fixed catalogue of services (public)" },
    { name: "Availability", description: "Free starts (public)" },
    { name: "Profile", description: "The caller's own profile (Firebase ID token)" },
    { name: "Marketing", description: "Offers subscription with double opt-in" },
    { name: "Bookings", description: "The caller's own bookings (Firebase ID token)" },
    { name: "Admin: schedule", description: "Working hours (verified administrator)" },
    { name: "Admin: bookings", description: "All bookings (verified administrator)" },
  ],
  paths: paths(),
  components: {
    securitySchemes: {
      [SECURITY_SCHEME]: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Firebase ID token (JWT)",
        description: "A Firebase ID token of your own session (frontend: `await auth.currentUser.getIdToken()`). Not issued by this API.",
      },
    },
    schemas: responseComponents(),
  },
});
