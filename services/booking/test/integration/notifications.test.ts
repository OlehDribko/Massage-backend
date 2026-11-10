import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { localDateTimeToInstant } from "../../src/modules/schedule/zoned-time.js";
import { DEFAULT_TUNING, type WorkerTuning } from "../../src/notifications/config.js";
import { createDispatcher, type Dispatcher, type Timers } from "../../src/notifications/dispatcher.js";
import { claimDeliveries, completeDelivery, nextWorkAt } from "../../src/notifications/store.js";
import { createWorker, type Worker } from "../../src/notifications/worker.js";
import { createDatabase, type Database } from "../../src/shared/database/database.js";
import { createFakeEmailProvider } from "../helpers/fake-email-provider.js";
import { createCapturingLogger } from "../helpers/logs.js";
import {
  bearer,
  bookingIdOf,
  countRows,
  createUsers,
  insertService,
  resetCalendar,
  startBookingStack,
  type BookingStack,
} from "./helpers/booking-app.js";

// Booking notifications against real PostgreSQL. Events come from the real
// booking API (the producer); the email provider is a fake (no real email).
// Most tests drive single passes (worker.tick) on a fake clock; the
// "in-process" tests run the real dispatcher woken by the API.

const STUDIO = "studio@example.invalid";
const CLIENT = "anna@example.invalid";

let stack: BookingStack;
let users: Awaited<ReturnType<typeof createUsers>>;
let serviceId: string;
const workerDatabases: Database[] = [];
let workerNow = Date.parse("2027-03-01T07:00:00Z");
const now = () => new Date(workerNow);

// The production schedule: 3 attempts, retries after 1 and 5 minutes
// (+10 % jitter with random 0.5 below: 66 s and 330 s).
const TUNING: WorkerTuning = DEFAULT_TUNING;

/** Hook the API calls after every booking write (set by the in-process tests). */
let onBookingWrite: () => void = () => undefined;

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
      senderName: "Стефанія Бень",
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
  stack = await startBookingStack(1, {
    notifications: {
      wake: () => {
        onBookingWrite();
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
  onBookingWrite = () => undefined;
  await resetAll();
  stack.setNow("2027-03-01T06:00:00Z");
  workerNow = Date.parse("2027-03-01T07:00:00Z");
  serviceId = await insertService(stack.db, { name: "Massage 60", durationMinutes: 60, priceCents: 6500 });
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

    expect((await worker.tick()).handled).toBe(2);
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
      expect(await worker.tick()).toEqual({ planned: 0, handled: 0 });
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
  it("a confirmation and a rescheduling superseded before sending are skipped for both recipients; the cancellation is sent to both", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    await request(stack.app).post(`/api/bookings/${id}/reschedule`).set(bearer(users.clientA)).send({ startsAt: paris("2027-03-03", "14:00") }).expect(200);
    await request(stack.app).post(`/api/admin/bookings/${id}/cancel`).set(bearer(users.admin)).send({ reason: "Fermeture" }).expect(200);

    const fake = createFakeEmailProvider({ now });
    await makeWorker(fake).worker.tick();

    expect(fake.sent.filter((email) => email.to === STUDIO).map((email) => email.subject.split(" :")[0])).toEqual([
      "Rendez-vous annulé",
    ]);
    expect((await deliveries()).filter((delivery) => delivery.recipientRole === "studio")).toMatchObject([
      { eventType: "booking.created", status: "skipped", resultCode: "superseded" },
      { eventType: "booking.rescheduled", status: "skipped", resultCode: "superseded" },
      { eventType: "booking.cancelled", status: "accepted" },
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

  it("a failing studio address does not hold back the client's emails; a cancellation drops the studio email waiting for a retry", async () => {
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
    // Studio: the confirmation waiting for its retry is dropped by the
    // cancellation, which does not wait behind it; its own attempt failed too.
    const studio = (await deliveries()).filter((delivery) => delivery.recipientRole === "studio");
    expect(studio.map((delivery) => [delivery.eventType, delivery.status, delivery.resultCode])).toEqual([
      ["booking.created", "skipped", "superseded"],
      ["booking.cancelled", "pending", null],
    ]);
    expect(studio[1]?.attempts).toBe(1);

    fake.setBehavior(() => "accept");
    workerNow += 2 * 60_000;
    await worker.tick();
    expect(fake.sent.filter((email) => email.to === STUDIO).map((email) => email.subject.split(" :")[0])).toEqual([
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

describe("studio email 30 minutes after the last change (agreed 2026-11-10)", () => {
  const T = Date.parse("2027-03-01T07:00:00Z");
  const MIN = 60_000;
  const at = (offsetMinutes: number) => new Date(T + offsetMinutes * MIN).toISOString();
  const toStudio = (fake: Fake) => fake.sent.filter((email) => email.to === STUDIO);
  const toClient = (fake: Fake) => fake.sent.filter((email) => email.to === CLIENT);
  const reschedule = (id: string, startsAt: string) =>
    request(stack.app).post(`/api/bookings/${id}/reschedule`).set(bearer(users.clientA)).send({ startsAt }).expect(200);

  beforeEach(() => {
    stack.setNow(at(0));
    workerNow = T;
  });

  it("the client's email goes at once; the studio's is due 30 minutes after the business event, by one timer", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const { worker } = makeWorker(fake);

    await worker.tick();
    expect(toClient(fake).map((email) => email.subject)).toEqual(["Votre rendez-vous est confirmé"]);
    expect(toStudio(fake)).toEqual([]);
    const studio = (await deliveries()).find((delivery) => delivery.recipientRole === "studio");
    expect(studio?.nextAttemptAt.toISOString()).toBe(at(30));
    expect((await nextWorkAt(workerDb().prisma)).at?.toISOString()).toBe(at(30));

    workerNow = T + 30 * MIN - 1;
    await worker.tick();
    expect(toStudio(fake)).toEqual([]);
    workerNow = T + 30 * MIN;
    await worker.tick();
    expect(toStudio(fake).map((email) => email.subject.split(" :")[0])).toEqual(["Nouveau rendez-vous"]);
  });

  it("a move restarts the countdown; the studio gets one email with the current state and no intermediate moves", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const { worker } = makeWorker(fake);
    await worker.tick();

    stack.setNow(at(20));
    await reschedule(id, paris("2027-03-03", "10:00"));
    workerNow = T + 20 * MIN;
    await worker.tick();
    stack.setNow(at(25));
    await reschedule(id, paris("2027-03-04", "15:00"));
    workerNow = T + 25 * MIN;
    await worker.tick();

    workerNow = T + 54 * MIN;
    await worker.tick();
    expect(toStudio(fake)).toEqual([]);
    workerNow = T + 55 * MIN;
    await worker.tick();
    const [email, ...more] = toStudio(fake);
    expect(more).toEqual([]);
    // Nothing reached the studio before: a new booking, at its current time.
    expect(email?.subject).toBe("Nouveau rendez-vous : Massage 60, jeudi 4 mars 2027 à 15:00");
    expect(email?.text).not.toMatch(/Ancien horaire|mars 2027 à 09:00|mars 2027 à 10:00/);
    // The client got every change at once.
    expect(toClient(fake).map((sent) => sent.subject)).toEqual([
      "Votre rendez-vous est confirmé",
      "Votre rendez-vous a été déplacé",
      "Votre rendez-vous a été déplacé",
    ]);
    expect((await deliveries()).filter((delivery) => delivery.recipientRole === "studio").map((delivery) => delivery.resultCode)).toEqual([
      "superseded",
      "superseded",
      "accepted",
    ]);
  });

  it("after an accepted studio email, moves start a new countdown; the email compares with what the studio was told", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const { worker } = makeWorker(fake);
    workerNow = T + 30 * MIN;
    await worker.tick();
    expect(toStudio(fake)).toHaveLength(1);

    stack.setNow(at(40));
    await reschedule(id, paris("2027-03-03", "10:00"));
    stack.setNow(at(50));
    await reschedule(id, paris("2027-03-04", "15:00"));
    workerNow = T + 50 * MIN;
    await worker.tick();
    workerNow = T + 80 * MIN;
    await worker.tick();

    const moved = toStudio(fake)[1];
    expect(toStudio(fake)).toHaveLength(2);
    expect(moved?.subject.split(" :")[0]).toBe("Rendez-vous déplacé");
    expect(moved?.text).toContain("Ancien horaire : mardi 2 mars 2027 à 09:00");
    expect(moved?.text).toContain("Nouvel horaire : jeudi 4 mars 2027 à 15:00");
    expect(moved?.text).not.toContain("10:00");
  });

  it("moved and back before the studio's email: nothing new to tell, skipped as unchanged", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const { worker } = makeWorker(fake);
    workerNow = T + 30 * MIN;
    await worker.tick();
    stack.setNow(at(40));
    await reschedule(id, paris("2027-03-03", "10:00"));
    stack.setNow(at(45));
    await reschedule(id, paris("2027-03-02", "09:00"));
    workerNow = T + 75 * MIN;
    await worker.tick();
    expect(toStudio(fake)).toHaveLength(1);
    expect((await deliveries()).filter((delivery) => delivery.recipientRole === "studio").map((delivery) => delivery.resultCode)).toEqual([
      "accepted",
      "superseded",
      "unchanged",
    ]);
  });

  it("repeating the same request does not restart the countdown", async () => {
    const key = "notif-repeat-0001";
    const create = () =>
      request(stack.app)
        .post("/api/bookings")
        .set(bearer(users.clientA))
        .set("Idempotency-Key", key)
        .send({ serviceId, startsAt: paris("2027-03-02", "09:00") });
    const id = bookingIdOf(await create().expect(201));
    stack.setNow(at(20));
    await create().expect(200);
    await reschedule(id, paris("2027-03-02", "09:00"));
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "OutboxEvent"`)).toBe(1);

    const fake = createFakeEmailProvider({ now });
    workerNow = T + 30 * MIN;
    await makeWorker(fake).worker.tick();
    expect(toStudio(fake)).toHaveLength(1);
  });

  it("a cancellation goes to both at once, even before the studio's first email, and drops the delayed one", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const { worker } = makeWorker(fake);
    await worker.tick();
    stack.setNow(at(5));
    await request(stack.app).post(`/api/bookings/${id}/cancel`).set(bearer(users.clientA)).send({}).expect(200);
    workerNow = T + 5 * MIN;
    await worker.tick();

    expect(toStudio(fake).map((email) => email.subject.split(" :")[0])).toEqual(["Rendez-vous annulé"]);
    expect(toClient(fake).map((email) => email.subject)).toEqual(["Votre rendez-vous est confirmé", "Votre rendez-vous a été annulé"]);
    // Nothing is left for later: no timer at 30 minutes.
    expect(await nextWorkAt(workerDb().prisma)).toEqual({ at: null, unplanned: false });
    workerNow = T + 60 * MIN;
    await worker.tick();
    expect(toStudio(fake)).toHaveLength(1);
  });

  it("an attempt running when the booking is cancelled cannot be recalled, but it is not retried and does not hold back the cancellation", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const { worker } = makeWorker(fake);
    await worker.tick();
    workerNow = T + 30 * MIN;

    fake.setBehavior(() => ({ kind: "retryable", code: "provider_unavailable", retryAfterMs: null }));
    const release = fake.hold();
    const running = worker.tick();
    await expect.poll(() => fake.calls()).toBe(2);
    stack.setNow(at(31));
    await request(stack.app).post(`/api/bookings/${id}/cancel`).set(bearer(users.clientA)).send({}).expect(200);
    // The running attempt fails temporarily; the cancellation is accepted.
    fake.setBehavior((email) =>
      email.subject.startsWith("Nouveau") ? { kind: "retryable", code: "provider_unavailable", retryAfterMs: null } : "accept",
    );
    release();
    await running;
    await worker.tick();

    const studio = (await deliveries()).filter((delivery) => delivery.recipientRole === "studio");
    expect(studio.map((delivery) => [delivery.eventType, delivery.status, delivery.resultCode, delivery.attempts])).toEqual([
      ["booking.created", "skipped", "superseded", 1],
      ["booking.cancelled", "accepted", "accepted", 1],
    ]);
    expect(toStudio(fake).map((email) => email.subject.split(" :")[0])).toEqual(["Rendez-vous annulé"]);
  });

  it("an attempt the provider accepts while the booking is cancelled stays sent; the cancellation follows it", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const { worker } = makeWorker(fake);
    await worker.tick();
    workerNow = T + 30 * MIN;
    const release = fake.hold();
    const running = worker.tick();
    await expect.poll(() => fake.calls()).toBe(2);
    stack.setNow(at(31));
    await request(stack.app).post(`/api/bookings/${id}/cancel`).set(bearer(users.clientA)).send({}).expect(200);
    release();
    await running;
    await worker.tick();
    expect(toStudio(fake).map((email) => email.subject.split(" :")[0])).toEqual(["Nouveau rendez-vous", "Rendez-vous annulé"]);
  });

  it("an expired lease of a stopped worker is dropped by the cancellation at once; that worker's late result is discarded", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    const { worker } = makeWorker(fake);
    await worker.tick();
    // Another process claimed the studio's email at minute 30 and stopped.
    const [claimed] = await claimDeliveries(workerDb().prisma, {
      now: new Date(T + 30 * MIN),
      owner: "worker-stopped",
      leaseMs: TUNING.leaseMs,
      limit: 1,
      maxAttempts: TUNING.maxAttempts,
    });
    expect(claimed?.recipientRole).toBe("studio");

    stack.setNow(at(32));
    await request(stack.app).post(`/api/bookings/${id}/cancel`).set(bearer(users.clientA)).send({}).expect(200);
    workerNow = T + 32 * MIN;
    await worker.tick();
    expect(toStudio(fake).map((email) => email.subject.split(" :")[0])).toEqual(["Rendez-vous annulé"]);

    const late = await completeDelivery(workerDb().prisma, {
      id: claimed?.id ?? "",
      leaseToken: claimed?.leaseToken ?? "",
      now: new Date(T + 33 * MIN),
      completion: { status: "pending", nextAttemptAt: new Date(T + 34 * MIN), lastErrorCode: "provider_unavailable", refundAttempt: false },
    });
    expect(late).toBe(false);
    expect((await deliveries()).find((delivery) => delivery.recipientRole === "studio")).toMatchObject({ status: "skipped", resultCode: "superseded" });
  });

  it("after a restart every committed change counts before an overdue email; the countdown runs from the business event", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    stack.setNow(at(10));
    await reschedule(id, paris("2027-03-03", "10:00"));
    // No sender ran meanwhile; a fresh process starts at minute 45.
    const fake = createFakeEmailProvider({ now });
    workerNow = T + 45 * MIN;
    await makeWorker(fake, { id: "worker-after-restart" }).worker.tick();

    // Due at minute 40 (the move + 30), not 45 + 30: sent on this first pass.
    expect(toStudio(fake).map((email) => email.subject)).toEqual(["Nouveau rendez-vous : Massage 60, mercredi 3 mars 2027 à 10:00"]);
    const studio = (await deliveries()).filter((delivery) => delivery.recipientRole === "studio");
    expect(studio.map((delivery) => [delivery.resultCode, delivery.nextAttemptAt.toISOString()])).toEqual([
      ["superseded", at(30)],
      ["accepted", at(40)],
    ]);
  });

  it("two API processes: the cancellation reaches each recipient once and no stale email follows", async () => {
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    stack.setNow(at(10));
    await reschedule(id, paris("2027-03-03", "10:00"));
    stack.setNow(at(12));
    await request(stack.app).post(`/api/bookings/${id}/cancel`).set(bearer(users.clientA)).send({}).expect(200);

    const fake = createFakeEmailProvider({ now });
    workerNow = T + 45 * MIN;
    await Promise.all([makeWorker(fake, { id: "worker-a" }).worker.tick(), makeWorker(fake, { id: "worker-b" }).worker.tick()]);
    expect(toStudio(fake).map((email) => email.subject.split(" :")[0])).toEqual(["Rendez-vous annulé"]);
    expect(toClient(fake).map((email) => email.subject)).toEqual(["Votre rendez-vous a été annulé"]);
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
    expect((await deliveries())[0]?.attempts).toBe(1); // 1 minute passed, Retry-After asked for 2
    workerNow += 60_000;
    await worker.tick();
    const [second] = await deliveries();
    expect(second).toMatchObject({ status: "pending", attempts: 2 });
    expect((second?.nextAttemptAt.getTime() ?? 0) - workerNow).toBe(330_000); // 5 min + jitter
    workerNow += 330_000;
    await worker.tick();
    expect((await deliveries())[0]).toMatchObject({ status: "accepted", attempts: 3 });
    expect(clientCalls).toBe(3);
  });

  it("a Retry-After beyond 10 minutes is not shortened: automatic processing ends with a fixed reason", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    fake.setBehavior((email) =>
      email.to === CLIENT ? { kind: "retryable", code: "rate_limited", retryAfterMs: 10 * 60_000 + 1 } : "accept",
    );
    const { worker } = makeWorker(fake);
    await worker.tick();
    expect(await deliveries()).toMatchObject([
      { recipientRole: "client", status: "failed", resultCode: "retry_after_too_long", lastErrorCode: "rate_limited", attempts: 1 },
      { recipientRole: "studio", status: "accepted" },
    ]);
    // No attempt earlier than asked, and none later either: it stays failed.
    workerNow += 24 * 3_600_000;
    expect(await worker.tick()).toEqual({ planned: 0, handled: 0 });
    expect(fake.calls()).toBe(2);
  });

  it("a Retry-After of exactly 10 minutes is waited for in full", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    let first = true;
    fake.setBehavior((email) => {
      if (email.to === CLIENT && first) {
        first = false;
        return { kind: "retryable", code: "rate_limited", retryAfterMs: 10 * 60_000 };
      }
      return "accept";
    });
    const { worker } = makeWorker(fake);
    await worker.tick();
    const [client] = await deliveries();
    expect(client).toMatchObject({ status: "pending", attempts: 1 });
    expect((client?.nextAttemptAt.getTime() ?? 0) - workerNow).toBe(10 * 60_000);
    workerNow += 10 * 60_000 - 1;
    await worker.tick();
    expect((await deliveries())[0]?.attempts).toBe(1); // not before the provider's time
    workerNow += 1;
    await worker.tick();
    expect((await deliveries())[0]).toMatchObject({ status: "accepted", attempts: 2 });
  });

  it("stops after the attempt limit with a visible failed state", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    fake.setBehavior((email) => (email.to === CLIENT ? { kind: "retryable", code: "timeout", retryAfterMs: null } : "accept"));
    const { worker } = makeWorker(fake);
    for (let i = 0; i < 6; i += 1) {
      await worker.tick();
      workerNow += 10 * 60_000;
    }
    expect((await deliveries())[0]).toMatchObject({ status: "failed", resultCode: "attempts_exhausted", lastErrorCode: "timeout", attempts: 3 });
    expect(fake.calls()).toBe(4); // 3 to the client, 1 to the studio
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

  it("a provider configuration error is not retried: one attempt, failed, visible in the log", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    fake.setBehavior(() => ({ kind: "configuration", code: "provider_auth" }));
    const { worker, logs } = makeWorker(fake);
    await worker.tick();
    expect(await deliveries()).toMatchObject([
      { recipientRole: "client", status: "failed", resultCode: "provider_auth", attempts: 1 },
      { recipientRole: "studio", status: "failed", resultCode: "provider_auth", attempts: 1 },
    ]);
    expect(logs.raw()).toContain("provider_auth");

    fake.setBehavior(() => "accept");
    workerNow += 60 * 60_000;
    expect(await worker.tick()).toEqual({ planned: 0, handled: 0 });
    expect(fake.calls()).toBe(2);
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
    workerNow += 2 * 60_000;
    await makeWorker(fake, { id: "second", database: workerDb() }).worker.tick();
    expect((await deliveries()).map((delivery) => [delivery.recipientRole, delivery.status, delivery.attempts])).toEqual([
      ["client", "accepted", 2],
      ["studio", "accepted", 1],
    ]);
  });

  it("at most three attempts per recipient, also across restarts and an interrupted last attempt", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    fake.setBehavior((email) => (email.to === CLIENT ? { kind: "retryable", code: "provider_unavailable", retryAfterMs: null } : "accept"));
    await makeWorker(fake, { id: "process-1" }).worker.tick(); // attempt 1
    workerNow += 10 * 60_000;
    await makeWorker(fake, { id: "process-2", database: workerDb() }).worker.tick(); // attempt 2, after a restart
    workerNow += 10 * 60_000;
    // Attempt 3 is claimed by a process that stops before recording a result.
    const db = workerDb();
    const [third] = await claimDeliveries(db.prisma, { now: now(), owner: "process-3", leaseMs: TUNING.leaseMs, limit: 1, maxAttempts: TUNING.maxAttempts });
    expect(third).toMatchObject({ recipientRole: "client", attempts: 3 });

    workerNow += TUNING.leaseMs + 1;
    await makeWorker(fake, { id: "process-4", database: workerDb() }).worker.tick();
    const [client] = await deliveries();
    expect(client).toMatchObject({ status: "failed", resultCode: "interrupted", attempts: 3 });
    expect(fake.sent.filter((email) => email.to === CLIENT)).toHaveLength(0);
    expect(fake.calls()).toBe(3); // client: 2 (the 3rd never reached the provider), studio: 1
  });
});

describe("in-process sending (dispatcher woken by the API)", () => {
  type Fake = ReturnType<typeof createFakeEmailProvider>;

  const startDispatcher = (fake: Fake, options: { timers?: Timers; database?: Database } = {}) => {
    const database = options.database ?? workerDb();
    const { worker } = makeWorker(fake, { database });
    const counted = { passes: 0, checks: 0 };
    const dispatcher: Dispatcher = createDispatcher({
      tick: () => {
        counted.passes += 1;
        return worker.tick();
      },
      nextWorkAt: () => {
        counted.checks += 1;
        return nextWorkAt(database.prisma);
      },
      stopWorker: worker.stop,
      logger: createCapturingLogger().logger,
      now,
      ...(options.timers === undefined ? {} : { timers: options.timers }),
    });
    return { dispatcher, counted };
  };

  /** Records timers instead of running them. */
  const recordedTimers = () => {
    const delays: number[] = [];
    const timers: Timers = {
      schedule: (_callback, delayMs) => {
        delays.push(delayMs);
        return () => undefined;
      },
    };
    return { timers, delays };
  };

  it("a booking wakes the sender; the HTTP response does not wait for the email", async () => {
    const fake = createFakeEmailProvider({ now });
    const release = fake.hold();
    const { dispatcher } = startDispatcher(fake);
    onBookingWrite = dispatcher.wake;

    // The provider is held: the booking still answers 201 at once.
    await book(users.clientA, paris("2027-03-02", "09:00"));
    expect(fake.sent).toHaveLength(0);
    release();
    await dispatcher.idle();
    expect(fake.sent.map((email) => email.to)).toEqual([CLIENT, STUDIO]);
    await dispatcher.stop();
  });

  it("no database access once all work is done: no timer, nothing runs later", async () => {
    const fake = createFakeEmailProvider({ now });
    const { timers, delays } = recordedTimers();
    const { dispatcher, counted } = startDispatcher(fake, { timers });
    onBookingWrite = dispatcher.wake;
    await book(users.clientA, paris("2027-03-02", "09:00"));
    await dispatcher.idle();
    expect(fake.sent).toHaveLength(2);
    expect(dispatcher.scheduledAt()).toBeNull();
    expect(delays).toEqual([]);

    const before = { ...counted };
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(counted).toEqual(before);
    await dispatcher.stop();
  });

  it("a temporary error leaves exactly one timer, at the retry time stored in the database", async () => {
    const fake = createFakeEmailProvider({ now });
    fake.setBehavior((email) => (email.to === CLIENT ? { kind: "retryable", code: "network", retryAfterMs: null } : "accept"));
    const { timers, delays } = recordedTimers();
    const { dispatcher } = startDispatcher(fake, { timers });
    onBookingWrite = dispatcher.wake;
    await book(users.clientA, paris("2027-03-02", "09:00"));
    await dispatcher.idle();
    const [client] = await deliveries();
    expect(client).toMatchObject({ status: "pending", attempts: 1 });
    expect(dispatcher.scheduledAt()).toEqual(client?.nextAttemptAt);
    expect(delays).toEqual([66_000]);
    await dispatcher.stop();
  });

  it("a delayed studio email leaves exactly one timer, at its due time; nothing touches the database before it", async () => {
    stack.setNow("2027-03-01T07:00:00Z");
    workerNow = Date.parse("2027-03-01T07:00:00Z");
    const fake = createFakeEmailProvider({ now });
    const { timers, delays } = recordedTimers();
    const { dispatcher, counted } = startDispatcher(fake, { timers });
    onBookingWrite = dispatcher.wake;
    await book(users.clientA, paris("2027-03-02", "09:00"));
    await dispatcher.idle();
    expect(fake.sent.map((email) => email.to)).toEqual([CLIENT]);
    expect(dispatcher.scheduledAt()?.toISOString()).toBe("2027-03-01T07:30:00.000Z");
    expect(delays).toEqual([30 * 60_000]);
    const before = { ...counted };
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(counted).toEqual(before);
    await dispatcher.stop();
  });

  it("start-up recovery: work committed while no sender ran is picked up on start", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00")); // no sender running (hook is a no-op)
    await book(users.clientB, paris("2027-03-02", "15:00"));
    const fake = createFakeEmailProvider({ now });
    const { dispatcher } = startDispatcher(fake);
    dispatcher.start();
    await dispatcher.idle();
    expect(fake.sent).toHaveLength(4);
    await dispatcher.stop();
  });

  it("start-up recovery respects a lease still held by another process, and takes it over once it expires", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    await makeWorker(fake, { tuning: { ...TUNING, batchSize: 0 } }).worker.tick(); // plan only
    await claimDeliveries(workerDb().prisma, { now: now(), owner: "other-process", leaseMs: TUNING.leaseMs, limit: 1, maxAttempts: 3 });

    const { timers, delays } = recordedTimers();
    const { dispatcher } = startDispatcher(fake, { timers });
    dispatcher.start();
    await dispatcher.idle();
    expect(fake.sent.map((email) => email.to)).toEqual([STUDIO]); // the client's delivery is leased
    expect(delays).toEqual([TUNING.leaseMs]); // timer at the lease expiry

    workerNow += TUNING.leaseMs + 1;
    dispatcher.wake(); // what the timer would do
    await dispatcher.idle();
    expect(fake.sent.map((email) => email.to)).toEqual([STUDIO, CLIENT]);
    await dispatcher.stop();
  });

  it("graceful stop: the email in flight is finished, nothing new is claimed, nothing is left leased", async () => {
    await book(users.clientA, paris("2027-03-02", "09:00"));
    await book(users.clientB, paris("2027-03-02", "15:00"));
    const fake = createFakeEmailProvider({ now });
    const release = fake.hold();
    const { dispatcher } = startDispatcher(fake);
    dispatcher.start();
    while (fake.calls() === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const stopping = dispatcher.stop();
    release();
    await stopping;

    expect(fake.calls()).toBe(1);
    const states = (await deliveries()).map((delivery) => delivery.status);
    expect(states.filter((status) => status === "accepted")).toHaveLength(1);
    expect(states.filter((status) => status === "in_progress")).toHaveLength(0);
    expect(states.filter((status) => status === "pending")).toHaveLength(3);
    expect(await countRows(stack.db, `SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE status = 'pending' AND attempts > 0`)).toBe(0);
  });
});

describe("notification status in the booking API", () => {
  const notificationOf = (response: request.Response): unknown => {
    const body: unknown = response.body;
    return z.object({ booking: z.object({ notification: z.unknown() }) }).parse(body).booking.notification;
  };
  const adminNotificationsOf = (response: request.Response): unknown => {
    const body: unknown = response.body;
    return z.object({ booking: z.object({ notifications: z.unknown() }) }).parse(body).booking.notifications;
  };

  it("the client sees only their own email's state; the admin sees both recipients next to the booking", async () => {
    stack.setNow("2027-03-01T07:00:00Z");
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    const own = await request(stack.app).get(`/api/bookings/${id}`).set(bearer(users.clientA)).expect(200);
    expect(notificationOf(own)).toEqual({ event: "created", status: "pending", reason: null });

    const fake = createFakeEmailProvider({ now });
    fake.setBehavior((email) => (email.to === STUDIO ? { kind: "rejected", code: "provider_rejected" } : "accept"));
    const { worker } = makeWorker(fake);
    await worker.tick();
    // The studio's email waits for its 30 minutes.
    const waiting = await request(stack.app).get(`/api/admin/bookings/${id}`).set(bearer(users.admin)).expect(200);
    expect(adminNotificationsOf(waiting)).toMatchObject([{ event: "created", studio: { status: "pending", reason: "scheduled", attempts: 0 } }]);
    workerNow += 30 * 60_000;
    await worker.tick();

    const after = await request(stack.app).get(`/api/bookings/${id}`).set(bearer(users.clientA)).expect(200);
    expect(notificationOf(after)).toEqual({ event: "created", status: "accepted", reason: null });
    const list = await request(stack.app).get("/api/bookings").set(bearer(users.clientA)).expect(200);
    expect(JSON.stringify(list.body)).toContain('"status":"accepted"');
    // Nothing about the studio or the provider reaches the client.
    expect(JSON.stringify(after.body)).not.toContain("studio");
    expect(JSON.stringify(after.body)).not.toContain("provider");

    // Another client: the booking does not exist for them (no status either).
    await request(stack.app).get(`/api/bookings/${id}`).set(bearer(users.clientB)).expect(404);
    // A client cannot use the admin routes.
    await request(stack.app).get(`/api/admin/bookings/${id}`).set(bearer(users.clientA)).expect(403);

    const admin = await request(stack.app).get(`/api/admin/bookings/${id}`).set(bearer(users.admin)).expect(200);
    expect(adminNotificationsOf(admin)).toMatchObject([
      {
        event: "created",
        client: { status: "accepted", reason: null, attempts: 1 },
        studio: { status: "failed", reason: "provider_rejected", attempts: 1 },
      },
    ]);
    const day = await request(stack.app).get("/api/admin/bookings?date=2027-03-02").set(bearer(users.admin)).expect(200);
    expect(JSON.stringify(day.body)).toContain('"reason":"provider_rejected"');
    // Admin views carry fixed codes only: no addresses of recipients, no provider ids.
    expect(JSON.stringify(admin.body)).not.toContain(STUDIO);
    expect(JSON.stringify(admin.body)).not.toContain("fake-");
  });

  it("a failed email does not change the booking; an interrupted attempt is not shown as sending forever", async () => {
    stack.setNow("2027-03-01T07:00:00Z");
    const id = await book(users.clientA, paris("2027-03-02", "09:00"));
    const fake = createFakeEmailProvider({ now });
    fake.setBehavior((email) => (email.to === CLIENT ? { kind: "retryable", code: "timeout", retryAfterMs: null } : "accept"));
    const { worker } = makeWorker(fake);
    for (let i = 0; i < 3; i += 1) {
      await worker.tick();
      workerNow += 10 * 60_000;
    }
    const failed = await request(stack.app).get(`/api/bookings/${id}`).set(bearer(users.clientA)).expect(200);
    expect(failed.body).toMatchObject({ booking: { status: "confirmed", notification: { status: "failed", reason: "not_sent" } } });

    // Reschedule; the new email's attempt is claimed by a process that stops.
    await request(stack.app).post(`/api/bookings/${id}/reschedule`).set(bearer(users.clientA)).send({ startsAt: paris("2027-03-03", "14:00") }).expect(200);
    await makeWorker(fake, { tuning: { ...TUNING, batchSize: 0 } }).worker.tick(); // plan only
    await claimDeliveries(workerDb().prisma, { now: now(), owner: "stopped", leaseMs: TUNING.leaseMs, limit: 2, maxAttempts: 3 });
    stack.setNow(new Date(workerNow + 1_000).toISOString());
    const sending = await request(stack.app).get(`/api/bookings/${id}`).set(bearer(users.clientA)).expect(200);
    expect(notificationOf(sending)).toEqual({ event: "rescheduled", status: "sending", reason: null });
    stack.setNow(new Date(workerNow + TUNING.leaseMs + 1).toISOString());
    const interrupted = await request(stack.app).get(`/api/bookings/${id}`).set(bearer(users.clientA)).expect(200);
    expect(notificationOf(interrupted)).toEqual({ event: "rescheduled", status: "interrupted", reason: null });
  });
});
