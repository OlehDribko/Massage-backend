import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { localDateTimeToInstant } from "../../src/modules/schedule/zoned-time.js";
import { DEFAULT_TUNING, type WorkerTuning } from "../../src/notifications/config.js";
import { claimDeliveries, completeDelivery } from "../../src/notifications/store.js";
import { createWorker, type Worker } from "../../src/notifications/worker.js";
import { createDatabase, type Database } from "../../src/shared/database/database.js";
import { killRunningChildren, startTsProcess } from "../helpers/child-process.js";
import { createFakeEmailProvider } from "../helpers/fake-email-provider.js";
import { createCapturingLogger } from "../helpers/logs.js";
import {
  bearer,
  bookingIdOf,
  countRows,
  createUsers,
  resetCalendar,
  serviceIdOf,
  startBookingStack,
  type BookingStack,
} from "./helpers/booking-app.js";

// Notifications worker against real PostgreSQL. Events come from the real
// booking API (the producer); the email provider is a fake (no real email).

const STUDIO = "studio@example.invalid";
const CLIENT = "anna@example.invalid";

let stack: BookingStack;
let users: Awaited<ReturnType<typeof createUsers>>;
let serviceId: string;
const workerDatabases: Database[] = [];
let workerNow = Date.parse("2027-03-01T07:00:00Z");
const now = () => new Date(workerNow);

const TUNING: WorkerTuning = {
  ...DEFAULT_TUNING,
  pollIntervalMs: 10,
  maxAttempts: 3,
  retryBaseMs: 1_000,
  retryCapMs: 10_000,
  configurationPauseMs: 300_000,
};

const paris = (date: string, hhmm: string): string => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return localDateTimeToInstant(date, Number(h) * 60 + Number(m), "Europe/Paris").toISOString();
};

const workerDb = (): Database => {
  const database = createDatabase(
    { url: stack.db.url("app"), sslMode: "disable", poolMax: 4, connectTimeoutMs: 5_000, queryTimeoutMs: 10_000 },
    createCapturingLogger().logger,
  );
  workerDatabases.push(database);
  return database;
};

type Fake = ReturnType<typeof createFakeEmailProvider>;

const makeWorker = (
  fake: Fake,
  options: { database?: Database; allowlist?: string[] | null; studioEmail?: string; tuning?: WorkerTuning; id?: string } = {},
): { worker: Worker; logs: ReturnType<typeof createCapturingLogger> } => {
  const logs = createCapturingLogger();
  const database = options.database ?? workerDb();
  return {
    worker: createWorker({
      prisma: database.prisma,
      provider: fake.provider,
      logger: logs.logger,
      workerId: options.id ?? "worker-test",
      studioEmail: options.studioEmail ?? STUDIO,
      recipientAllowlist: options.allowlist === undefined || options.allowlist === null ? null : new Set(options.allowlist),
      tuning: options.tuning ?? TUNING,
      now,
      random: () => 0.5,
    }),
    logs,
  };
};

let keyCounter = 0;
const book = async (token: string, startsAt: string): Promise<string> => {
  const response = await request(stack.app)
    .post("/api/bookings")
    .set(bearer(token))
    .set("Idempotency-Key", `notif-${String((keyCounter += 1)).padStart(8, "0")}`)
    .send({ serviceId, startsAt });
  expect(response.status).toBe(201);
  return bookingIdOf(response);
};

const deliverySchema = z.object({
  id: z.uuid(),
  eventType: z.string(),
  recipientRole: z.string(),
  recipientEmail: z.string().nullable(),
  status: z.string(),
  attempts: z.number(),
  resultCode: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  nextAttemptAt: z.date(),
});

const deliveries = async () => {
  const result = await stack.db.query(
    "admin",
    `SELECT id, "eventType", "recipientRole"::text AS "recipientRole", "recipientEmail", status::text AS status, attempts,
            "resultCode", "lastErrorCode", "providerMessageId", "nextAttemptAt"
       FROM "NotificationDelivery" ORDER BY "eventPosition", "recipientRole"`,
  );
  const rows: unknown = result.rows;
  return z.array(deliverySchema).parse(rows);
};

const resetAll = () => resetCalendar(stack.db);

beforeAll(async () => {
  stack = await startBookingStack(1);
  users = await createUsers(stack);
});

afterAll(async () => {
  await killRunningChildren();
  await Promise.all(workerDatabases.map((database) => database.close()));
  await stack.close();
});

beforeEach(async () => {
  await resetAll();
  stack.setNow("2027-03-01T06:00:00Z");
  workerNow = Date.parse("2027-03-01T07:00:00Z");
  const created = await request(stack.app)
    .post("/api/admin/services")
    .set(bearer(users.admin))
    .send({ name: "Massage 60", durationMinutes: 60, priceCents: 6500 });
  serviceId = serviceIdOf(created);
  await request(stack.app)
    .put("/api/admin/schedule/weekly")
    .set(bearer(users.admin))
    .send({ intervals: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: "09:00", end: "21:00" })) })
    .expect(200);
});

describe("planning and sending", () => {
  it("one created booking: one email to the client, one to the studio, each with its own template; reprocessing adds nothing", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const { worker, logs } = makeWorker(fake);

    expect(await worker.tick()).toBe(2);
    expect(fake.sent.map((email) => [email.to, email.subject])).toEqual([
      [CLIENT, "Votre rendez-vous est confirmé"],
      [STUDIO, "Nouveau rendez-vous : Massage 60, mardi 2 mars 2027 à 09:00"],
    ]);
    expect(fake.sent[0]?.text).not.toContain("+33612345678");
    expect(fake.sent[1]?.text).toContain("+33612345678");
    expect(await deliveries()).toMatchObject([
      { recipientRole: "client", status: "accepted", resultCode: "accepted", attempts: 1, providerMessageId: "<fake-1@test>" },
      { recipientRole: "studio", status: "accepted", resultCode: "accepted", attempts: 1 },
    ]);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "NotificationEvent" WHERE status = 'planned'`)).toBe(1);

    for (let i = 0; i < 3; i += 1) {
      expect(await worker.tick()).toBe(0);
    }
    expect(fake.sent).toHaveLength(2);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "NotificationDelivery"`)).toBe(2);
    // Logs carry ids and codes, never addresses or content.
    expect(logs.raw()).not.toContain(CLIENT);
    expect(logs.raw()).not.toContain(STUDIO);
    expect(logs.raw()).not.toContain("Massage 60");
  });

  it("recipients are fixed when an event is first planned: a new studio address does not add deliveries", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    await makeWorker(fake).worker.tick();
    await makeWorker(fake, { studioEmail: "new-studio@example.invalid" }).worker.tick();
    await makeWorker(fake, { studioEmail: "new-studio@example.invalid" }).worker.tick();
    expect((await deliveries()).map((delivery) => delivery.recipientEmail)).toEqual([CLIENT, STUDIO]);
    expect(fake.sent).toHaveLength(2);
  });

  it("the worker never changes or adds outbox events", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const before = await stack.db.query("admin", `SELECT id, type, payload::text, position FROM "OutboxEvent" ORDER BY position`);
    await makeWorker(createFakeEmailProvider({ now })).worker.tick();
    const after = await stack.db.query("admin", `SELECT id, type, payload::text, position FROM "OutboxEvent" ORDER BY position`);
    expect(after.rows).toEqual(before.rows);
    // The deprecated column stays (older API versions select it) and stays unused.
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "publishedAt" IS NOT NULL`)).toBe(0);
  });

  it("an unusable event gets a visible invalid state; a missing client address a failed delivery", async () => {
    await stack.db.query(
      "admin",
      `INSERT INTO "OutboxEvent" (id, type, "schemaVersion", "aggregateType", "aggregateId", "dedupeKey", payload, "occurredAt")
       VALUES (gen_random_uuid(), 'booking.created', 1, 'booking', gen_random_uuid(), 'manual:broken', '{"bookingId":"x"}', now()),
              (gen_random_uuid(), 'booking.created', 2, 'booking', gen_random_uuid(), 'manual:v2', '{}', now())`,
    );
    const fake = createFakeEmailProvider({ now });
    const { worker, logs } = makeWorker(fake);
    await worker.tick();
    const events = await stack.db.query("admin", `SELECT status::text AS status, "reasonCode" FROM "NotificationEvent" ORDER BY position`);
    expect(events.rows).toEqual([
      { status: "invalid", reasonCode: "invalid_payload" },
      { status: "invalid", reasonCode: "unsupported_schema_version" },
    ]);
    expect(await deliveries()).toEqual([]);
    expect(logs.raw()).toContain("invalid_payload");
    expect(fake.calls()).toBe(0);
  });
});

describe("order, staleness and independence", () => {
  it("client: a confirmation and a rescheduling superseded before sending are skipped, the cancellation is sent; the studio gets all three in order", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    await request(stack.app).post(`/api/bookings/${id}/reschedule`).set(bearer(users.clientA)).send({ startsAt: paris("2027-03-03", "14:00") }).expect(200);
    await request(stack.app).post(`/api/admin/bookings/${id}/cancel`).set(bearer(users.admin)).send({ reason: "Fermeture" }).expect(200);

    const fake = createFakeEmailProvider({ now });
    await makeWorker(fake).worker.tick();

    expect(fake.sent.filter((email) => email.to === STUDIO).map((email) => email.subject.split(" :")[0])).toEqual([
      "Nouveau rendez-vous",
      "Rendez-vous déplacé",
      "Rendez-vous annulé",
    ]);
    const toClient = fake.sent.filter((email) => email.to === CLIENT);
    expect(toClient.map((email) => email.subject)).toEqual(["Votre rendez-vous a été annulé"]);
    expect(toClient[0]?.text).toContain("Motif : Fermeture");
    expect((await deliveries()).filter((delivery) => delivery.recipientRole === "client")).toMatchObject([
      { eventType: "booking.created", status: "skipped", resultCode: "superseded" },
      { eventType: "booking.rescheduled", status: "skipped", resultCode: "superseded" },
      { eventType: "booking.cancelled", status: "accepted" },
    ]);
  });

  it("an email already accepted is never touched; the later one follows", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const { worker } = makeWorker(fake);
    await worker.tick();
    await request(stack.app).post(`/api/bookings/${id}/reschedule`).set(bearer(users.clientA)).send({ startsAt: paris("2027-03-03", "14:00") }).expect(200);
    await worker.tick();
    expect(fake.sent.filter((email) => email.to === CLIENT).map((email) => email.subject)).toEqual([
      "Votre rendez-vous est confirmé",
      "Votre rendez-vous a été déplacé",
    ]);
    expect((await deliveries()).filter((delivery) => delivery.recipientRole === "client").map((delivery) => delivery.status)).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  it("after a pause: a client confirmation of a session that already started is skipped; the studio still gets it", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    workerNow = Date.parse(paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    await makeWorker(fake).worker.tick();
    expect(await deliveries()).toMatchObject([
      { recipientRole: "client", status: "skipped", resultCode: "session_already_started" },
      { recipientRole: "studio", status: "accepted" },
    ]);
  });

  it("retries keep one recipient's order; a failing studio address does not hold back the client's emails", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    fake.setBehavior((email) =>
      email.to === STUDIO ? { kind: "retryable", code: "provider_unavailable", retryAfterMs: null } : "accept",
    );
    const { worker } = makeWorker(fake);
    await worker.tick();
    await request(stack.app).post(`/api/bookings/${id}/cancel`).set(bearer(users.clientA)).send({}).expect(200);
    workerNow += 60_000;
    await worker.tick();

    // Client: created was already accepted before the cancel, then the cancellation.
    expect(fake.sent.map((email) => [email.to, email.subject])).toEqual([
      [CLIENT, "Votre rendez-vous est confirmé"],
      [CLIENT, "Votre rendez-vous a été annulé"],
    ]);
    // Studio: the cancellation waits behind the failing confirmation (same chain, event order).
    const studio = (await deliveries()).filter((delivery) => delivery.recipientRole === "studio");
    expect(studio.map((delivery) => [delivery.eventType, delivery.status])).toEqual([
      ["booking.created", "pending"],
      ["booking.cancelled", "pending"],
    ]);
    expect(studio[1]?.attempts).toBe(0);

    fake.setBehavior(() => "accept");
    workerNow += 60_000;
    await worker.tick();
    expect(fake.sent.filter((email) => email.to === STUDIO).map((email) => email.subject.split(" :")[0])).toEqual([
      "Nouveau rendez-vous",
      "Rendez-vous annulé",
    ]);
  });

  it("outside production only allowlisted recipients get email; others are skipped visibly, not redirected", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    await makeWorker(fake, { allowlist: [STUDIO] }).worker.tick();
    expect(fake.sent.map((email) => email.to)).toEqual([STUDIO]);
    expect(await deliveries()).toMatchObject([
      { recipientRole: "client", status: "skipped", resultCode: "recipient_not_allowed", recipientEmail: CLIENT },
      { recipientRole: "studio", status: "accepted" },
    ]);
  });
});

describe("retries and provider errors", () => {
  it("retries temporary errors with backoff and Retry-After, then succeeds", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    let clientCalls = 0;
    fake.setBehavior((email) => {
      if (email.to !== CLIENT) {
        return "accept";
      }
      clientCalls += 1;
      return clientCalls <= 2 ? { kind: "retryable", code: "rate_limited", retryAfterMs: 120_000 } : "accept";
    });
    const { worker } = makeWorker(fake);
    await worker.tick();
    const [client] = await deliveries();
    expect(client).toMatchObject({ status: "pending", attempts: 1, lastErrorCode: "rate_limited" });
    expect((client?.nextAttemptAt.getTime() ?? 0) - workerNow).toBeGreaterThanOrEqual(120_000);

    workerNow += 60_000;
    await worker.tick();
    expect((await deliveries())[0]?.attempts).toBe(1); // not due yet
    workerNow += 120_000;
    await worker.tick();
    workerNow += 180_000;
    await worker.tick();
    expect((await deliveries())[0]).toMatchObject({ status: "accepted", attempts: 3 });
  });

  it("stops after the attempt limit with a visible failed state", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    fake.setBehavior((email) => (email.to === CLIENT ? { kind: "retryable", code: "timeout", retryAfterMs: null } : "accept"));
    const { worker } = makeWorker(fake);
    for (let i = 0; i < 6; i += 1) {
      await worker.tick();
      workerNow += 60_000;
    }
    expect((await deliveries())[0]).toMatchObject({ status: "failed", resultCode: "attempts_exhausted", lastErrorCode: "timeout", attempts: 3 });
  });

  it("a permanent rejection fails only that delivery", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    fake.setBehavior((email) => (email.to === CLIENT ? { kind: "rejected", code: "provider_rejected" } : "accept"));
    await makeWorker(fake).worker.tick();
    expect(await deliveries()).toMatchObject([
      { recipientRole: "client", status: "failed", resultCode: "provider_rejected", attempts: 1 },
      { recipientRole: "studio", status: "accepted" },
    ]);
  });

  it("a provider configuration error pauses the worker and keeps everything pending without using attempts", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    await book(users.clientB, paris("2027-03-02", "15:00"));
    const fake = createFakeEmailProvider({ now });
    fake.setBehavior(() => ({ kind: "configuration", code: "provider_auth" }));
    const { worker, logs } = makeWorker(fake);
    await worker.tick();
    expect(fake.calls()).toBe(1);
    const afterError = await deliveries();
    expect(afterError.every((delivery) => delivery.status === "pending" && delivery.attempts === 0)).toBe(true);
    expect(afterError.filter((delivery) => delivery.lastErrorCode === "provider_auth")).toHaveLength(1);
    expect(logs.raw()).toContain("provider_auth");

    workerNow += 60_000;
    expect(await worker.tick()).toBe(0); // still paused
    expect(fake.calls()).toBe(1);

    fake.setBehavior(() => "accept");
    workerNow += TUNING.configurationPauseMs;
    await worker.tick();
    expect((await deliveries()).every((delivery) => delivery.status === "accepted")).toBe(true);
  });
});

describe("leases, crashes and concurrency", () => {
  it("two workers in parallel (separate pools): every delivery is sent exactly once", async () => {
    for (const [token, time] of [
      [users.clientA, "09:00"],
      [users.clientB, "10:30"],
      [users.clientA, "12:00"],
      [users.clientB, "13:30"],
      [users.clientA, "15:00"],
    ] satisfies [string, string][]) {
      await book(token, paris("2027-03-02", time));
    }
    const fake = createFakeEmailProvider({ now });
    const a = makeWorker(fake, { id: "worker-a", tuning: { ...TUNING, batchSize: 2 } }).worker;
    const b = makeWorker(fake, { id: "worker-b", tuning: { ...TUNING, batchSize: 2 } }).worker;
    await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
    await Promise.all([a.tick(), b.tick()]);

    expect(fake.sent).toHaveLength(10);
    expect(new Set(fake.sent.map((email) => email.idempotencyKey)).size).toBe(10);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE status = 'accepted' AND attempts = 1`)).toBe(10);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "NotificationEvent"`)).toBe(5);
  });

  it("a leased delivery is not taken by another worker until the lease expires; the expired worker cannot overwrite the result", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const db = workerDb();
    await makeWorker(fake, { tuning: { ...TUNING, batchSize: 0 } }).worker.tick(); // plan only
    const [held] = await claimDeliveries(db.prisma, { now: now(), owner: "stalled", leaseMs: TUNING.leaseMs, limit: 1, maxAttempts: 3 });
    expect(held?.recipientRole).toBe("client");

    const other = makeWorker(fake, { id: "worker-b" }).worker;
    await other.tick();
    expect(fake.sent.map((email) => email.to)).toEqual([STUDIO]); // client is leased

    workerNow += TUNING.leaseMs + 1;
    await other.tick();
    expect(fake.sent.map((email) => email.to)).toEqual([STUDIO, CLIENT]);
    expect((await deliveries())[0]).toMatchObject({ status: "accepted", attempts: 2 });

    // The stalled worker wakes up and tries to record a failure: discarded.
    const kept = await completeDelivery(db.prisma, {
      id: held?.id ?? "",
      leaseToken: held?.leaseToken ?? "",
      now: now(),
      completion: { status: "failed", resultCode: "provider_rejected", lastErrorCode: "provider_rejected" },
    });
    expect(kept).toBe(false);
    expect((await deliveries())[0]).toMatchObject({ status: "accepted" });
  });

  it("crash before the provider accepted: the next worker sends it once", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const db = workerDb();
    await makeWorker(fake, { tuning: { ...TUNING, batchSize: 0 } }).worker.tick();
    await claimDeliveries(db.prisma, { now: now(), owner: "crashed", leaseMs: TUNING.leaseMs, limit: 2, maxAttempts: 3 });
    workerNow += TUNING.leaseMs + 1;
    await makeWorker(fake, { id: "restarted" }).worker.tick();
    expect(fake.sent).toHaveLength(2);
    expect((await deliveries()).map((delivery) => delivery.status)).toEqual(["accepted", "accepted"]);
  });

  it("crash after the provider accepted: within the idempotency window the repeat is a duplicate, not a second email", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const db = workerDb();
    await makeWorker(fake, { tuning: { ...TUNING, batchSize: 0 } }).worker.tick();
    const claimed = await claimDeliveries(db.prisma, { now: now(), owner: "crashed", leaseMs: TUNING.leaseMs, limit: 2, maxAttempts: 3 });
    // The crashed worker got as far as the provider, then died before recording.
    for (const delivery of claimed) {
      await fake.provider.send({ to: delivery.recipientEmail ?? "", subject: "s", html: "h", text: "t", idempotencyKey: delivery.id, tags: [] });
    }
    workerNow += TUNING.leaseMs + 1;
    await makeWorker(fake, { id: "restarted" }).worker.tick();
    expect(fake.sent).toHaveLength(2); // only the crashed worker's emails
    expect((await deliveries()).map((delivery) => [delivery.status, delivery.resultCode, delivery.providerMessageId])).toEqual([
      ["accepted", "accepted_duplicate", null],
      ["accepted", "accepted_duplicate", null],
    ]);
  });

  it("residual risk, documented: after the idempotency window a crash-after-accept repeat is sent again", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const db = workerDb();
    await makeWorker(fake, { tuning: { ...TUNING, batchSize: 0 } }).worker.tick();
    const [first] = await claimDeliveries(db.prisma, { now: now(), owner: "crashed", leaseMs: TUNING.leaseMs, limit: 1, maxAttempts: 3 });
    await fake.provider.send({ to: first?.recipientEmail ?? "", subject: "s", html: "h", text: "t", idempotencyKey: first?.id ?? "", tags: [] });
    workerNow += 31 * 60_000;
    await makeWorker(fake, { id: "restarted" }).worker.tick();
    expect(fake.sent.filter((email) => email.to === CLIENT)).toHaveLength(2);
  });

  it("restart with persisted work: a new worker continues pending retries", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    fake.setBehavior((email) => (email.to === CLIENT ? { kind: "retryable", code: "network", retryAfterMs: null } : "accept"));
    await makeWorker(fake, { id: "first" }).worker.tick();
    fake.setBehavior(() => "accept");
    workerNow += 60_000;
    await makeWorker(fake, { id: "second", database: workerDb() }).worker.tick();
    expect((await deliveries()).map((delivery) => [delivery.recipientRole, delivery.status, delivery.attempts])).toEqual([
      ["client", "accepted", 2],
      ["studio", "accepted", 1],
    ]);
  });

  it("graceful stop: the email in flight is finished, nothing new is claimed, nothing is left leased", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    await book(users.clientB, paris("2027-03-02", "15:00"));
    const fake = createFakeEmailProvider({ now });
    const release = fake.hold();
    const { worker } = makeWorker(fake, { tuning: { ...TUNING, batchSize: 4 } });
    const running = worker.run();
    while (fake.calls() === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const stopping = worker.stop();
    release();
    await stopping;
    await running;

    expect(fake.calls()).toBe(1);
    const states = (await deliveries()).map((delivery) => delivery.status);
    expect(states.filter((status) => status === "accepted")).toHaveLength(1);
    expect(states.filter((status) => status === "in_progress")).toHaveLength(0);
    expect(states.filter((status) => status === "pending")).toHaveLength(3);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE status = 'pending' AND attempts > 0`)).toBe(0);
  });
});

describe("worker process", () => {
  it("with sending disabled (the default) it exits without touching the database or a provider", async () => {
    const child = startTsProcess("src/notifications/main.ts", { DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" });
    const exit = await child.exited;
    expect(exit.code).toBe(0);
    expect(child.output()).toContain("booking notifications are disabled");
  });

  it("refuses to start on staging without an allowlist", async () => {
    const child = startTsProcess("src/notifications/main.ts", {
      ENABLE_BOOKING_NOTIFICATIONS: "true",
      NOTIFICATIONS_ENVIRONMENT: "staging",
      DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none",
      DATABASE_SSL_MODE: "disable",
      NOTIFICATION_STUDIO_EMAIL: STUDIO,
      BREVO_API_KEY: "xkeysib-SENTINEL",
      EMAIL_FROM_NAME: "Studio",
      EMAIL_FROM_EMAIL: "noreply@example.invalid",
    });
    const exit = await child.exited;
    expect(exit.code).toBe(1);
    expect(child.output()).toContain("NOTIFICATION_RECIPIENT_ALLOWLIST: required");
    expect(child.output()).not.toContain("SENTINEL");
  });
});
