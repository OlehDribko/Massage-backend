import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { localDateTimeToInstant } from "../../src/modules/schedule/zoned-time.js";
import { DEFAULT_TUNING } from "../../src/notifications/config.js";
import { BOOKING_EVENT_TYPES } from "../../src/notifications/event-contract.js";
import { claimDeliveries, failExhausted, nextWorkAt, planNewEvents } from "../../src/notifications/store.js";
import { formatPrice } from "../../src/notifications/templates.js";
import { createWorker, type Worker } from "../../src/notifications/worker.js";
import { createDatabase, type Database } from "../../src/shared/database/database.js";
import { identity } from "../helpers/fake-identity.js";
import { createFakeEmailProvider } from "../helpers/fake-email-provider.js";
import { createCapturingLogger } from "../helpers/logs.js";
import {
  bearer,
  countRows,
  createUsers,
  insertService,
  resetCalendar,
  startBookingStack,
  type BookingStack,
} from "./helpers/booking-app.js";

// Gift card requests against real PostgreSQL and the real application. Only
// Firebase token verification and the email provider are fakes (no real
// email). The studio email goes through the same Notifications worker as
// bookings, driven here by single passes on a controllable clock.

const STUDIO = "studio@example.invalid";
const CLIENT_EMAIL = "anna@example.invalid";

let stack: BookingStack;
let users: Awaited<ReturnType<typeof createUsers>>;
const workerDatabases: Database[] = [];
let wakes = 0;

const giftCardSchema = z.object({
  id: z.uuid(),
  number: z.number(),
  status: z.string(),
  amountCents: z.number(),
  currency: z.string(),
  description: z.string().nullable(),
  preferredContactChannel: z.string(),
  createdAt: z.string(),
  notification: z.object({ status: z.string(), reason: z.string().nullable() }).nullable(),
});
const giftCardOf = (response: request.Response) => {
  const body: unknown = response.body;
  return z.object({ giftCardRequest: giftCardSchema }).parse(body).giftCardRequest;
};

const adminViewSchema = z.object({
  id: z.uuid(),
  number: z.number(),
  status: z.string(),
  description: z.string().nullable(),
  client: z.object({ profileId: z.uuid(), name: z.string(), email: z.string(), phone: z.string() }),
  allowedStatuses: z.array(z.string()),
  history: z.array(
    z.object({
      fromStatus: z.string().nullable(),
      toStatus: z.string(),
      at: z.string(),
      by: z.object({ profileId: z.uuid(), role: z.string(), name: z.string().nullable(), email: z.string().nullable() }),
    }),
  ),
  notification: z.object({ status: z.string(), reason: z.string().nullable(), attempts: z.number() }).nullable(),
});
const adminViewOf = (response: request.Response) => {
  const body: unknown = response.body;
  return z.object({ giftCardRequest: adminViewSchema, changed: z.boolean().optional() }).parse(body);
};
const listOf = (response: request.Response) => {
  const body: unknown = response.body;
  return z
    .object({ timeZone: z.string(), page: z.number(), pageSize: z.number(), total: z.number(), giftCardRequests: z.array(adminViewSchema) })
    .parse(body);
};
const errorOf = (response: request.Response) => {
  const body: unknown = response.body;
  return z
    .object({
      code: z.string(),
      blockers: z.array(z.string()).optional(),
      errors: z.array(z.object({ field: z.array(z.union([z.string(), z.number()])) })).optional(),
      retryAfterSeconds: z.number().optional(),
      allowed: z.array(z.string()).optional(),
    })
    .parse(body);
};

let keyCounter = 0;
const newKey = () => `gift-${String((keyCounter += 1)).padStart(8, "0")}`;

const submit = (token: string, body: Record<string, unknown>, key: string | null = newKey()) => {
  const call = request(stack.app).post("/api/gift-card-requests").set(bearer(token));
  return (key === null ? call : call.set("Idempotency-Key", key)).send(body);
};

const VALID = { amountCents: 15000, description: "Pour ma sœur", preferredContactChannel: "whatsapp" };

const makeWorker = (
  fake: ReturnType<typeof createFakeEmailProvider>,
  now: () => Date,
  allowlist: string[] | null = null,
  handledEventTypes?: readonly string[],
): { worker: Worker; logs: ReturnType<typeof createCapturingLogger>; prisma: Database["prisma"] } => {
  const database = createDatabase(
    { url: stack.db.url("app"), sslMode: "disable", poolMax: 4, connectTimeoutMs: 5_000, queryTimeoutMs: 10_000 },
    createCapturingLogger().logger,
  );
  workerDatabases.push(database);
  const logs = createCapturingLogger();
  return {
    worker: createWorker({
      prisma: database.prisma,
      provider: fake.provider,
      logger: logs.logger,
      workerId: "worker-gift",
      studioEmail: STUDIO,
      senderName: "Stefania Example",
      recipientAllowlist: allowlist === null ? null : new Set(allowlist),
      tuning: DEFAULT_TUNING,
      ...(handledEventTypes === undefined ? {} : { handledEventTypes }),
      now,
      random: () => 0.5,
    }),
    logs,
    prisma: database.prisma,
  };
};

beforeAll(async () => {
  stack = await startBookingStack(2, {
    notifications: {
      wake: () => {
        wakes += 1;
      },
    },
  });
  users = await createUsers(stack);
});

afterAll(async () => {
  await Promise.all(workerDatabases.map((database) => database.close()));
  await stack.close();
});

beforeEach(async () => {
  await resetCalendar(stack.db);
  stack.setNow("2027-03-01T07:00:00Z");
  wakes = 0;
});

describe("who may submit", () => {
  it("a ready client: 201, status new, EUR from the server, the studio email pending; the sender is woken", async () => {
    const response = await submit(users.clientA, VALID);
    expect(response.status).toBe(201);
    const created = giftCardOf(response);
    expect(created).toMatchObject({
      status: "new",
      amountCents: 15000,
      currency: "EUR",
      description: "Pour ma sœur",
      preferredContactChannel: "whatsapp",
      createdAt: "2027-03-01T07:00:00.000Z",
      notification: { status: "pending", reason: null },
    });
    expect(response.body).not.toHaveProperty("giftCardRequest.client");
    expect(wakes).toBe(1);
  });

  it("without a token 401; guest, unverified, incomplete profile and admin 403 with the booking blockers", async () => {
    expect((await request(stack.app).post("/api/gift-card-requests").set("Idempotency-Key", newKey()).send(VALID)).status).toBe(401);
    const cases: [string, string[]][] = [
      [users.guest, ["anonymous_session", "email_not_verified", "name_missing", "phone_missing"]],
      [users.unverified, ["email_not_verified"]],
      [users.incomplete, ["name_missing", "phone_missing"]],
      [users.admin, ["not_a_client"]],
    ];
    for (const [token, blockers] of cases) {
      const response = await submit(token, VALID);
      expect(response.status).toBe(403);
      expect(errorOf(response)).toMatchObject({ code: "GIFT_CARD_REQUEST_NOT_READY", blockers });
    }
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "GiftCardRequest"`)).toBe(0);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "OutboxEvent"`)).toBe(0);
  });

  it("contacts come from the verified identity and the profile; the body cannot supply them", async () => {
    for (const extra of [{ email: "attacker@example.invalid" }, { name: "Someone" }, { phone: "+33600000000" }, { currency: "USD" }]) {
      const response = await submit(users.clientA, { ...VALID, ...extra });
      expect(response.status).toBe(400);
      expect(errorOf(response).code).toBe("VALIDATION_FAILED");
    }
    const id = giftCardOf(await submit(users.clientA, VALID)).id;
    const admin = adminViewOf(await request(stack.app).get(`/api/admin/gift-card-requests/${id}`).set(bearer(users.admin)).expect(200));
    expect(admin.giftCardRequest.client).toMatchObject({ name: "Anna Client", email: CLIENT_EMAIL, phone: "+33612345678" });
  });

  it("the snapshot stays when the profile changes later", async () => {
    stack.identities.issue("token-snapshot", identity({ uid: "uid-snapshot", email: "snap@example.invalid" }));
    await request(stack.app).post("/api/me/sync").set(bearer("token-snapshot")).expect(200);
    await request(stack.app).patch("/api/me").set(bearer("token-snapshot")).send({ name: "Before", phone: "+33611223344" }).expect(200);
    const id = giftCardOf(await submit("token-snapshot", VALID)).id;
    await request(stack.app).patch("/api/me").set(bearer("token-snapshot")).send({ name: "After", phone: "+33655667788" }).expect(200);
    const view = adminViewOf(await request(stack.app).get(`/api/admin/gift-card-requests/${id}`).set(bearer(users.admin)).expect(200));
    expect(view.giftCardRequest.client).toMatchObject({ name: "Before", phone: "+33611223344", email: "snap@example.invalid" });
  });
});

describe("validation", () => {
  it("amount: positive whole cents within the stored range; numbers only", async () => {
    for (const amountCents of [0, -1, 1.5, "1500", null, 2_147_483_648, Number.MAX_SAFE_INTEGER + 2]) {
      const response = await submit(users.clientA, { ...VALID, amountCents });
      expect(response.status, String(amountCents)).toBe(400);
      expect(errorOf(response).errors?.[0]?.field).toEqual(["amountCents"]);
    }
    expect((await submit(users.clientA, { description: VALID.description, preferredContactChannel: VALID.preferredContactChannel })).status).toBe(400);
    // Any amount, no fixed values: 1 cent and the largest stored value.
    expect(giftCardOf(await submit(users.clientA, { ...VALID, amountCents: 1 }).expect(201)).amountCents).toBe(1);
    expect(giftCardOf(await submit(users.clientA, { ...VALID, amountCents: 2_147_483_647 }).expect(201)).amountCents).toBe(2_147_483_647);
  });

  it("description: optional, trimmed, empty is null, at most 1000 characters, no control characters", async () => {
    expect(giftCardOf(await submit(users.clientA, { amountCents: 100, preferredContactChannel: "email" }).expect(201)).description).toBeNull();
    expect(giftCardOf(await submit(users.clientA, { ...VALID, description: "" }).expect(201)).description).toBeNull();
    expect(giftCardOf(await submit(users.clientA, { ...VALID, description: "   " }).expect(201)).description).toBeNull();
    expect(giftCardOf(await submit(users.clientA, { ...VALID, description: null }).expect(201)).description).toBeNull();
    expect(giftCardOf(await submit(users.clientB, { ...VALID, description: `  ${"é".repeat(1000)}  ` }).expect(201)).description).toBe("é".repeat(1000));
    expect(giftCardOf(await submit(users.clientB, { ...VALID, description: "Ligne 1\nLigne 2\tfin" }).expect(201)).description).toBe("Ligne 1\nLigne 2\tfin");
    for (const description of ["x".repeat(1001), "bell\u0007", "nul\u0000", 42]) {
      const response = await submit(users.clientB, { ...VALID, description });
      expect(response.status).toBe(400);
      expect(errorOf(response).errors?.[0]?.field).toEqual(["description"]);
    }
  });

  it("contact channel: email, phone or whatsapp only", async () => {
    for (const channel of ["email", "phone", "whatsapp"]) {
      expect((await submit(users.clientA, { ...VALID, preferredContactChannel: channel })).status).toBe(201);
    }
    for (const channel of ["sms", "WhatsApp", "", undefined]) {
      const response = await submit(users.clientB, { ...VALID, preferredContactChannel: channel });
      expect(response.status).toBe(400);
    }
  });

  it("Idempotency-Key is required and checked", async () => {
    expect(errorOf(await submit(users.clientA, VALID, null).expect(400)).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(errorOf(await submit(users.clientA, VALID, "short").expect(400)).code).toBe("IDEMPOTENCY_KEY_INVALID");
  });
});

describe("repeats", () => {
  it("the same key and body return the same request (200, Idempotent-Replayed); another body is 422; one event only", async () => {
    const key = newKey();
    const first = await submit(users.clientA, VALID, key).expect(201);
    const repeat = await submit(users.clientA, VALID, key).expect(200);
    expect(repeat.headers["idempotent-replayed"]).toBe("true");
    expect(giftCardOf(repeat).id).toBe(giftCardOf(first).id);
    expect(errorOf(await submit(users.clientA, { ...VALID, amountCents: 15001 }, key).expect(422)).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(errorOf(await submit(users.clientA, { ...VALID, description: "Autre" }, key).expect(422)).code).toBe("IDEMPOTENCY_KEY_REUSED");
    // Keys are per client: another client may use the same one.
    expect((await submit(users.clientB, VALID, key)).status).toBe(201);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "GiftCardRequest"`)).toBe(2);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'gift_card_request.created'`)).toBe(2);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "GiftCardRequestStatusChange"`)).toBe(2);
  });

  it("parallel repeats on two API instances create one request and one event", async () => {
    const key = newKey();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(stack.apps[i % 2] ?? stack.app)
          .post("/api/gift-card-requests")
          .set(bearer(users.clientA))
          .set("Idempotency-Key", key)
          .send(VALID),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(responses.map((response) => giftCardOf(response).id)).size).toBe(1);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "GiftCardRequest"`)).toBe(1);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "OutboxEvent"`)).toBe(1);
  });

  it("at most 5 new requests per client in 24 h (429 with Retry-After), also in parallel; replays do not count", async () => {
    const results = await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        request(stack.apps[i % 2] ?? stack.app)
          .post("/api/gift-card-requests")
          .set(bearer(users.clientA))
          .set("Idempotency-Key", newKey())
          .send(VALID),
      ),
    );
    expect(results.filter((response) => response.status === 201)).toHaveLength(5);
    const refused = results.filter((response) => response.status === 429);
    expect(refused).toHaveLength(2);
    for (const response of refused) {
      expect(errorOf(response)).toMatchObject({ code: "GIFT_CARD_REQUEST_LIMIT_REACHED", retryAfterSeconds: 86400 });
      expect(response.headers["retry-after"]).toBe("86400");
    }
    // Other clients are not affected; time frees the limit.
    expect((await submit(users.clientB, VALID)).status).toBe(201);
    stack.advance(24 * 60 * 60_000 + 1);
    expect((await submit(users.clientA, VALID)).status).toBe(201);
  });
});

describe("rate limit: 5 new requests per client in a rolling 24 hours", () => {
  it("a repeat with the same key returns the request even after the limit, and does not use it up", async () => {
    const keys = Array.from({ length: 5 }, () => newKey());
    const first = giftCardOf(await submit(users.clientA, VALID, keys[0]).expect(201));
    // Repeats before the limit cost nothing: four more new requests still fit.
    for (let i = 0; i < 3; i += 1) {
      expect(giftCardOf(await submit(users.clientA, VALID, keys[0]).expect(200)).id).toBe(first.id);
    }
    for (const key of keys.slice(1)) {
      await submit(users.clientA, VALID, key).expect(201);
    }
    // Limit reached: a new key is refused, every earlier key still replays its own request.
    expect((await submit(users.clientA, VALID)).status).toBe(429);
    for (const key of keys) {
      const replay = await submit(users.clientA, VALID, key).expect(200);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
    }
    expect(giftCardOf(await submit(users.clientA, VALID, keys[0]).expect(200)).id).toBe(first.id);
    // A different body under an old key is still a reuse error, not a limit error.
    expect(errorOf(await submit(users.clientA, { ...VALID, amountCents: 1 }, keys[0]).expect(422)).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "GiftCardRequest"`)).toBe(5);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "OutboxEvent"`)).toBe(5);
  });

  it("429 has a fixed code and the exact time until the oldest request leaves the window; the window rolls", async () => {
    const hour = 60 * 60_000;
    for (let i = 0; i < 5; i += 1) {
      stack.setNow(new Date(Date.parse("2027-03-01T07:00:00Z") + i * hour).toISOString());
      await submit(users.clientA, VALID).expect(201);
    }
    stack.setNow("2027-03-01T12:00:00Z");
    const refused = await submit(users.clientA, VALID).expect(429);
    // Oldest at 07:00 → allowed again from 2027-03-02T07:00: 19 h from 12:00.
    expect(errorOf(refused)).toMatchObject({ code: "GIFT_CARD_REQUEST_LIMIT_REACHED", retryAfterSeconds: 19 * 3600 });
    expect(refused.headers["retry-after"]).toBe(String(19 * 3600));
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "GiftCardRequest"`)).toBe(5);

    stack.setNow("2027-03-02T06:59:59.999Z"); // 1 ms before: still inside, rounded up to 1 s
    expect(errorOf(await submit(users.clientA, VALID).expect(429)).retryAfterSeconds).toBe(1);
    stack.setNow("2027-03-02T07:00:00Z"); // exactly 24 h after the oldest: it has left the window
    await submit(users.clientA, VALID).expect(201);
    // Now 08:00, 09:00, 10:00, 11:00 and the new one: full again until 08:00 leaves.
    expect(errorOf(await submit(users.clientA, VALID).expect(429)).retryAfterSeconds).toBe(3600);
  });

  it("parallel requests on two instances never pass the limit, also when the client already has requests", async () => {
    await submit(users.clientA, VALID).expect(201);
    await submit(users.clientA, VALID).expect(201);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(stack.apps[i % 2] ?? stack.app)
          .post("/api/gift-card-requests")
          .set(bearer(users.clientA))
          .set("Idempotency-Key", newKey())
          .send(VALID),
      ),
    );
    expect(results.filter((response) => response.status === 201)).toHaveLength(3);
    expect(results.filter((response) => response.status === 429)).toHaveLength(7);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "GiftCardRequest"`)).toBe(5);
  });
});

describe("administration", () => {
  const create = async (token: string, body: Record<string, unknown> = VALID) => giftCardOf(await submit(token, body).expect(201)).id;
  const setStatus = (id: string, status: string, token = users.admin) =>
    request(stack.app).patch(`/api/admin/gift-card-requests/${id}/status`).set(bearer(token)).send({ status });

  it("only a verified admin reads or changes requests; clients and guests get 403, no token 401", async () => {
    const id = await create(users.clientA);
    for (const token of [users.clientA, users.clientB, users.guest, users.unverified]) {
      expect((await request(stack.app).get("/api/admin/gift-card-requests").set(bearer(token))).status).toBe(403);
      expect((await request(stack.app).get(`/api/admin/gift-card-requests/${id}`).set(bearer(token))).status).toBe(403);
      expect((await setStatus(id, "completed", token)).status).toBe(403);
    }
    expect((await request(stack.app).get(`/api/admin/gift-card-requests/${id}`)).status).toBe(401);
    // A client has no route to read requests at all (own or others').
    expect((await request(stack.app).get(`/api/gift-card-requests/${id}`).set(bearer(users.clientA))).status).toBe(404);
    expect((await request(stack.app).get("/api/gift-card-requests").set(bearer(users.clientA))).status).toBe(404);
    expect((await request(stack.app).delete(`/api/admin/gift-card-requests/${id}`).set(bearer(users.admin))).status).toBe(404);
  });

  it("detail: snapshot, history with the submission, allowed next statuses; unknown or malformed id is 404", async () => {
    const id = await create(users.clientA);
    const view = adminViewOf(await request(stack.app).get(`/api/admin/gift-card-requests/${id}`).set(bearer(users.admin)).expect(200)).giftCardRequest;
    expect(view.history).toEqual([
      { fromStatus: null, toStatus: "new", at: "2027-03-01T07:00:00.000Z", by: { profileId: view.client.profileId, role: "client", name: "Anna Client", email: CLIENT_EMAIL } },
    ]);
    expect(view.allowedStatuses).toEqual(["in_progress", "completed", "cancelled"]);
    expect(view.notification).toMatchObject({ status: "pending", reason: null, attempts: 0 });
    for (const bad of ["5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d", "not-a-uuid"]) {
      const response = await request(stack.app).get(`/api/admin/gift-card-requests/${bad}`).set(bearer(users.admin));
      expect(response.status).toBe(404);
      expect(errorOf(response).code).toBe("GIFT_CARD_REQUEST_NOT_FOUND");
      expect((await setStatus(bad, "completed")).status).toBe(404);
    }
  });

  it("status changes: allowed transitions, a repeat adds no history, every change has its admin and time", async () => {
    const id = await create(users.clientA);
    stack.setNow("2027-03-01T09:30:00Z");
    const moved = adminViewOf(await setStatus(id, "in_progress").expect(200));
    expect(moved.changed).toBe(true);
    expect(moved.giftCardRequest.status).toBe("in_progress");
    expect(moved.giftCardRequest.allowedStatuses).toEqual(["completed", "cancelled"]);
    const again = adminViewOf(await setStatus(id, "in_progress").expect(200));
    expect(again.changed).toBe(false);
    expect(again.giftCardRequest.history).toHaveLength(2);

    const back = await setStatus(id, "new").expect(409);
    expect(errorOf(back)).toMatchObject({ code: "GIFT_CARD_STATUS_TRANSITION_NOT_ALLOWED", allowed: ["completed", "cancelled"] });
    stack.setNow("2027-03-02T10:00:00Z");
    const done = adminViewOf(await setStatus(id, "completed").expect(200)).giftCardRequest;
    expect(done.allowedStatuses).toEqual(["in_progress"]);
    for (const status of ["new", "cancelled"]) {
      expect(errorOf(await setStatus(id, status).expect(409))).toMatchObject({ allowed: ["in_progress"] });
    }
    expect(adminViewOf(await setStatus(id, "completed").expect(200)).changed).toBe(false);

    const cancelled = await create(users.clientB);
    expect(adminViewOf(await setStatus(cancelled, "cancelled").expect(200)).giftCardRequest.allowedStatuses).toEqual(["in_progress"]);
    expect((await setStatus(cancelled, "completed")).status).toBe(409);
    expect((await setStatus(cancelled, "new")).status).toBe(409);
    expect((await setStatus(cancelled, "paid")).status).toBe(400);
    expect((await request(stack.app).patch(`/api/admin/gift-card-requests/${cancelled}/status`).set(bearer(users.admin)).send({ status: "new", note: "x" })).status).toBe(400);
  });

  it("a mistaken completed or cancelled is reopened to in_progress: recorded in the history, no new request, no new email", async () => {
    const fake = createFakeEmailProvider({ now: () => new Date("2027-03-01T07:00:00Z") });
    const { worker } = makeWorker(fake, () => new Date("2027-03-01T07:00:00Z"));
    const completed = await create(users.clientA);
    const cancelled = await create(users.clientB);
    await worker.tick();
    expect(fake.sent).toHaveLength(2);
    const counts = async () => ({
      requests: await countRows(stack.db, `SELECT count(*)::int AS n FROM "GiftCardRequest"`),
      events: await countRows(stack.db, `SELECT count(*)::int AS n FROM "OutboxEvent"`),
      deliveries: await countRows(stack.db, `SELECT count(*)::int AS n FROM "NotificationDelivery"`),
    });
    const before = await counts();

    stack.setNow("2027-03-01T10:00:00Z");
    await setStatus(completed, "completed").expect(200);
    await setStatus(cancelled, "cancelled").expect(200);
    stack.setNow("2027-03-01T11:00:00Z");
    const reopened = adminViewOf(await setStatus(completed, "in_progress").expect(200));
    expect(reopened.changed).toBe(true);
    expect(reopened.giftCardRequest.status).toBe("in_progress");
    expect(reopened.giftCardRequest.history.map((entry) => [entry.fromStatus, entry.toStatus, entry.at, entry.by.role])).toEqual([
      [null, "new", "2027-03-01T07:00:00.000Z", "client"],
      ["new", "completed", "2027-03-01T10:00:00.000Z", "admin"],
      ["completed", "in_progress", "2027-03-01T11:00:00.000Z", "admin"],
    ]);
    const restored = adminViewOf(await setStatus(cancelled, "in_progress").expect(200)).giftCardRequest;
    expect(restored.history.map((entry) => [entry.fromStatus, entry.toStatus])).toEqual([
      [null, "new"],
      ["new", "cancelled"],
      ["cancelled", "in_progress"],
    ]);
    // Done again after the correction.
    expect(adminViewOf(await setStatus(completed, "completed").expect(200)).giftCardRequest.history).toHaveLength(4);

    await worker.tick();
    expect(fake.sent).toHaveLength(2);
    expect(await counts()).toEqual(before);
  });

  it("parallel status changes apply one after another: one history entry per real change", async () => {
    const id = await create(users.clientA);
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(stack.apps[i % 2] ?? stack.app).patch(`/api/admin/gift-card-requests/${id}/status`).set(bearer(users.admin)).send({ status: "in_progress" }),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.filter((response) => adminViewOf(response).changed)).toHaveLength(1);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "GiftCardRequestStatusChange" WHERE "toStatus" = 'in_progress'`)).toBe(1);
  });

  it("list: newest first, pages, filters by status and creation dates (studio time zone, inclusive)", async () => {
    const ids: string[] = [];
    const times = ["2027-02-28T23:30:00Z", "2027-03-01T08:00:00Z", "2027-03-02T10:00:00Z", "2027-03-03T22:59:00Z", "2027-03-03T23:00:00Z"];
    for (const [index, at] of times.entries()) {
      stack.setNow(at);
      ids.push(await create(index % 2 === 0 ? users.clientA : users.clientB));
    }
    stack.setNow("2027-03-05T08:00:00Z");
    await setStatus(ids[1] ?? "", "in_progress").expect(200);

    const all = listOf(await request(stack.app).get("/api/admin/gift-card-requests").set(bearer(users.admin)).expect(200));
    expect(all).toMatchObject({ timeZone: "Europe/Paris", page: 1, pageSize: 20, total: 5 });
    expect(all.giftCardRequests.map((item) => item.id)).toEqual([...ids].reverse());

    const page2 = listOf(await request(stack.app).get("/api/admin/gift-card-requests?pageSize=2&page=2").set(bearer(users.admin)).expect(200));
    expect(page2.total).toBe(5);
    expect(page2.giftCardRequests.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    const beyond = listOf(await request(stack.app).get("/api/admin/gift-card-requests?pageSize=2&page=4").set(bearer(users.admin)).expect(200));
    expect(beyond.giftCardRequests).toEqual([]);

    const inProgress = listOf(await request(stack.app).get("/api/admin/gift-card-requests?status=in_progress").set(bearer(users.admin)).expect(200));
    expect(inProgress.giftCardRequests.map((item) => item.id)).toEqual([ids[1]]);

    // Paris is UTC+1 in March: 2027-02-28T23:30Z is 2027-03-01 00:30, 2027-03-03T22:59Z is 23:59, 2027-03-03T23:00Z is already 2027-03-04.
    const march1to3 = listOf(
      await request(stack.app).get("/api/admin/gift-card-requests?createdFrom=2027-03-01&createdTo=2027-03-03").set(bearer(users.admin)).expect(200),
    );
    expect(march1to3.giftCardRequests.map((item) => item.id)).toEqual([ids[3], ids[2], ids[1], ids[0]]);
    const from4 = listOf(await request(stack.app).get("/api/admin/gift-card-requests?createdFrom=2027-03-04").set(bearer(users.admin)).expect(200));
    expect(from4.giftCardRequests.map((item) => item.id)).toEqual([ids[4]]);

    for (const query of ["status=paid", "createdFrom=2027-02-30", "createdFrom=2027-03-05&createdTo=2027-03-01", "page=0", "pageSize=101", "page=abc", "unknown=1"]) {
      const response = await request(stack.app).get(`/api/admin/gift-card-requests?${query}`).set(bearer(users.admin));
      expect(response.status, query).toBe(400);
      expect(errorOf(response).code).toBe("VALIDATION_FAILED");
    }
  });
});

describe("the studio email", () => {
  let workerNow = Date.parse("2027-03-01T07:00:00Z");
  const now = () => new Date(workerNow);
  const deliveries = async () => {
    const result = await stack.db.query(
      "admin",
      `SELECT "eventType", "recipientRole"::text AS role, "recipientEmail" AS email, status::text AS status, "resultCode", attempts, "nextAttemptAt"
         FROM "NotificationDelivery" ORDER BY "eventPosition", "recipientRole"`,
    );
    const rows: unknown = result.rows;
    return z
      .array(z.object({ eventType: z.string(), role: z.string(), email: z.string().nullable(), status: z.string(), resultCode: z.string().nullable(), attempts: z.number(), nextAttemptAt: z.date() }))
      .parse(rows);
  };

  beforeEach(() => {
    workerNow = Date.parse("2027-03-01T07:00:00Z");
  });

  it("one email to the studio at once (no 30-minute delay), none to the client; the content is complete and escaped; logs carry no contacts", async () => {
    const id = giftCardOf(
      await submit(users.clientA, { amountCents: 123456, description: "<b>Surprise</b> & \"merci\"\nà bientôt", preferredContactChannel: "phone" }).expect(201),
    ).id;
    const fake = createFakeEmailProvider({ now });
    const { worker, logs } = makeWorker(fake, now);
    expect(await worker.tick()).toEqual({ planned: 1, handled: 1 });

    expect(await deliveries()).toMatchObject([{ eventType: "gift_card_request.created", role: "studio", email: STUDIO, status: "accepted", attempts: 1 }]);
    expect(fake.sent).toHaveLength(1);
    const [email] = fake.sent;
    const number = adminViewOf(await request(stack.app).get(`/api/admin/gift-card-requests/${id}`).set(bearer(users.admin)).expect(200)).giftCardRequest.number;
    expect(email?.to).toBe(STUDIO);
    expect(email?.subject).toBe(`Demande de carte cadeau n°\u00a0${String(number)} : ${formatPrice(123456)}`);
    expect(email?.tags).toEqual(["gift_card_request.created", "studio"]);
    for (const part of [`n°\u00a0${String(number)}`, "Anna Client", CLIENT_EMAIL, "+33612345678", "Téléphone", "lundi 1 mars 2027 à 08:00"]) {
      expect(email?.text).toContain(part);
      expect(email?.html).toContain(part);
    }
    expect(email?.text).toContain('<b>Surprise</b> & "merci" à bientôt');
    expect(email?.html).toContain("&lt;b&gt;Surprise&lt;/b&gt; &amp; &quot;merci&quot; à bientôt");
    expect(email?.html).not.toContain("<b>Surprise</b>");

    const view = adminViewOf(await request(stack.app).get(`/api/admin/gift-card-requests/${id}`).set(bearer(users.admin)).expect(200)).giftCardRequest;
    expect(view.notification).toMatchObject({ status: "accepted", reason: null, attempts: 1 });
    expect(await worker.tick()).toEqual({ planned: 0, handled: 0 });
    expect(fake.sent).toHaveLength(1);
    for (const secret of [CLIENT_EMAIL, STUDIO, "+33612345678", "Anna Client", "Surprise"]) {
      expect(logs.raw()).not.toContain(secret);
    }
  });

  it("versions of the sender: an older process (booking events only, PR #55) leaves the request's event alone; this release sends it", async () => {
    // The older release handles exactly the booking events (BOOKING_EVENT_TYPES
    // is its HANDLED_EVENT_TYPES). Before PR #55, a process marked such an
    // event invalid for good and the studio email was lost.
    expect([...BOOKING_EVENT_TYPES].sort()).toEqual(["booking.cancelled", "booking.created", "booking.rescheduled"]);
    const id = giftCardOf(await submit(users.clientA, VALID).expect(201)).id;
    const fake = createFakeEmailProvider({ now });
    const older = makeWorker(fake, now, null, BOOKING_EVENT_TYPES);

    // Rolling deploy: the older task runs a pass first (woken by a booking, or at its start).
    expect(await older.worker.tick()).toEqual({ planned: 0, handled: 0 });
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "NotificationEvent"`)).toBe(0);
    expect(await nextWorkAt(older.prisma, BOOKING_EVENT_TYPES)).toEqual({ at: null, unplanned: false });
    const pending = adminViewOf(await request(stack.app).get(`/api/admin/gift-card-requests/${id}`).set(bearer(users.admin)).expect(200)).giftCardRequest;
    expect(pending.notification).toMatchObject({ status: "pending", reason: null });

    // This release plans and takes the email, then stops before a result (its lease expires).
    await planNewEvents(older.prisma, { now: now(), studioEmail: STUDIO, limit: 10, studioDelayMs: DEFAULT_TUNING.studioDelayMs });
    expect(await claimDeliveries(older.prisma, { now: now(), owner: "crashed", leaseMs: DEFAULT_TUNING.leaseMs, limit: 10, maxAttempts: 3 })).toHaveLength(1);
    workerNow += DEFAULT_TUNING.leaseMs + 1;
    // The older process still does not touch it: no claim, no failure (even with no attempts left), no timer.
    expect(await older.worker.tick()).toEqual({ planned: 0, handled: 0 });
    await stack.db.query("admin", `UPDATE "NotificationDelivery" SET attempts = 3`);
    expect(await failExhausted(older.prisma, { now: now(), maxAttempts: 3, eventTypes: BOOKING_EVENT_TYPES })).toBe(0);
    await stack.db.query("admin", `UPDATE "NotificationDelivery" SET attempts = 1`);
    expect((await nextWorkAt(older.prisma, BOOKING_EVENT_TYPES)).at).toBeNull();
    expect(await deliveries()).toMatchObject([{ eventType: "gift_card_request.created", status: "in_progress" }]);
    expect(fake.sent).toHaveLength(0);

    // This release (restart or the next wake) sends it.
    await makeWorker(fake, now).worker.tick();
    expect(fake.sent.map((email) => email.subject)).toEqual([expect.stringMatching(/^Demande de carte cadeau n°/)]);
    expect(await deliveries()).toMatchObject([{ eventType: "gift_card_request.created", status: "accepted" }]);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "NotificationEvent" WHERE status = 'invalid'`)).toBe(0);
  });

  it("a repeated submission sends no second email", async () => {
    const key = newKey();
    await submit(users.clientA, VALID, key).expect(201);
    const fake = createFakeEmailProvider({ now });
    const { worker } = makeWorker(fake, now);
    await worker.tick();
    await submit(users.clientA, VALID, key).expect(200);
    await worker.tick();
    expect(fake.sent).toHaveLength(1);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "NotificationDelivery"`)).toBe(1);
  });

  it("a provider failure keeps the request: status unchanged, the email visibly failed; retries are bounded", async () => {
    const id = giftCardOf(await submit(users.clientA, VALID).expect(201)).id;
    const fake = createFakeEmailProvider({ now });
    fake.setBehavior(() => ({ kind: "rejected", code: "provider_rejected" }));
    await makeWorker(fake, now).worker.tick();
    const view = adminViewOf(await request(stack.app).get(`/api/admin/gift-card-requests/${id}`).set(bearer(users.admin)).expect(200)).giftCardRequest;
    expect(view.status).toBe("new");
    expect(view.notification).toMatchObject({ status: "failed", reason: "provider_rejected" });

    const second = giftCardOf(await submit(users.clientB, VALID).expect(201)).id;
    fake.setBehavior(() => ({ kind: "retryable", code: "provider_unavailable", retryAfterMs: null }));
    const { worker } = makeWorker(fake, now);
    for (let i = 0; i < 5; i += 1) {
      await worker.tick();
      workerNow += 10 * 60_000;
    }
    const failed = adminViewOf(await request(stack.app).get(`/api/admin/gift-card-requests/${second}`).set(bearer(users.admin)).expect(200)).giftCardRequest;
    expect(failed.status).toBe("new");
    expect(failed.notification).toMatchObject({ status: "failed", reason: "temporary_errors", attempts: 3 });
  });

  it("outside production only allowlisted recipients get it; otherwise skipped visibly", async () => {
    const id = giftCardOf(await submit(users.clientA, VALID).expect(201)).id;
    const fake = createFakeEmailProvider({ now });
    await makeWorker(fake, now, ["someone-else@example.invalid"]).worker.tick();
    expect(fake.sent).toHaveLength(0);
    const view = adminViewOf(await request(stack.app).get(`/api/admin/gift-card-requests/${id}`).set(bearer(users.admin)).expect(200)).giftCardRequest;
    expect(view.notification).toMatchObject({ status: "skipped", reason: "test_environment" });
  });

  it("bookings keep their rules next to gift card requests: client email at once, studio email 30 minutes later", async () => {
    const serviceId = await insertService(stack.db, { name: "Massage 60", durationMinutes: 60, priceCents: 6500 });
    await request(stack.app)
      .put("/api/admin/schedule/weekly")
      .set(bearer(users.admin))
      .send({ intervals: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "21:00" })) })
      .expect(200);
    await request(stack.app)
      .post("/api/bookings")
      .set(bearer(users.clientA))
      .set("Idempotency-Key", newKey())
      .send({ serviceId, startsAt: localDateTimeToInstant("2027-03-02", 9 * 60, "Europe/Paris").toISOString() })
      .expect(201);
    await submit(users.clientA, VALID).expect(201);

    const fake = createFakeEmailProvider({ now });
    const { worker } = makeWorker(fake, now);
    expect(await worker.tick()).toEqual({ planned: 2, handled: 2 });
    expect(fake.sent.map((email) => email.subject)).toEqual([
      "Votre rendez-vous est confirmé",
      expect.stringMatching(/^Demande de carte cadeau n/),
    ]);
    const rows = await deliveries();
    expect(rows.map((row) => [row.eventType, row.role, row.status])).toEqual([
      ["booking.created", "client", "accepted"],
      ["booking.created", "studio", "pending"],
      ["gift_card_request.created", "studio", "accepted"],
    ]);
    expect(rows[1]?.nextAttemptAt.toISOString()).toBe("2027-03-01T07:30:00.000Z");
    workerNow = Date.parse("2027-03-01T07:30:00Z");
    await worker.tick();
    expect(fake.sent.map((email) => email.subject)[2]).toMatch(/^Nouveau rendez-vous : Massage 60/);
  });
});
