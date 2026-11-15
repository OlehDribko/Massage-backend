import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { localDateTimeToInstant } from "../../src/modules/schedule/zoned-time.js";
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

// Manual blocks of the calendar (ScheduleBlock) against real PostgreSQL and
// the real application: admin routes and their role check, the break on
// both sides, the grid after a block, conflicts with confirmed bookings,
// Idempotency-Key (also after a delete), DST, no events, and the race of a
// block against a booking under the calendar lock (two API instances).

let stack: BookingStack;
let users: Awaited<ReturnType<typeof createUsers>>;
let serviceId: string;

const NOW = "2027-03-01T06:00:00Z"; // Monday 07:00 in Paris
const DAY = "2027-03-03"; // Wednesday
const WEEK = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: "09:00", end: "20:30" }));

const admin = () => bearer(users.admin);
const paris = (date: string, hhmm: string): string => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return localDateTimeToInstant(date, Number(h) * 60 + Number(m), "Europe/Paris").toISOString();
};

const blockSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  note: z.string().nullable(),
  start: z.string(),
  end: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const blockOf = (body: unknown) => z.strictObject({ timeZone: z.literal("Europe/Paris"), block: blockSchema }).parse(body).block;
const errorOf = (body: unknown) => z.looseObject({ code: z.string() }).parse(body);

let keyCounter = 0;
const nextKey = (prefix: string) => `${prefix}-${String((keyCounter += 1)).padStart(8, "0")}`;

type BlockBody = { title: string; note?: string | null; start: string; end: string };
const createBlock = (body: BlockBody, key = nextKey("block"), token = admin(), app = stack.app) =>
  request(app).post("/api/admin/schedule/blocks").set(token).set("Idempotency-Key", key).send(body);
const patchBlock = (id: string, body: Record<string, unknown>) =>
  request(stack.app).patch(`/api/admin/schedule/blocks/${id}`).set(admin()).send(body);
const deleteBlock = (id: string) => request(stack.app).delete(`/api/admin/schedule/blocks/${id}`).set(admin());

const book = (token: string, startsAt: string, app = stack.app) =>
  request(app).post("/api/bookings").set(bearer(token)).set("Idempotency-Key", nextKey("booking")).send({ serviceId, startsAt });

const slotsOn = async (date: string): Promise<string[]> => {
  const response = await request(stack.app).get(`/api/services/${serviceId}/availability?from=${date}&to=${date}`).expect(200);
  const parsed = z
    .object({ days: z.array(z.object({ date: z.string(), slots: z.array(z.object({ startsAt: z.string() })) })) })
    .parse(response.body);
  return parsed.days.find((day) => day.date === date)?.slots.map((slot) => slot.startsAt) ?? [];
};

const outboxCount = () => countRows(stack.db, `SELECT count(*)::int AS n FROM "OutboxEvent"`);
const blockCount = () => countRows(stack.db, `SELECT count(*)::int AS n FROM "ScheduleBlock"`);

beforeAll(async () => {
  stack = await startBookingStack(2);
  users = await createUsers(stack);
});

beforeEach(async () => {
  stack.setNow(NOW);
  await resetCalendar(stack.db);
  serviceId = await insertService(stack.db, { name: "Massage 60", durationMinutes: 60, priceCents: 6500 });
  await request(stack.app).put("/api/admin/schedule/weekly").set(admin()).send({ intervals: WEEK }).expect(200);
});

afterAll(async () => {
  await stack.close();
});

describe("admin routes and role", () => {
  it("create, read, list, change and delete a block; only a verified admin", async () => {
    const created = await createBlock({ title: " Rendez-vous ", note: "Médecin", start: `${DAY}T14:00`, end: `${DAY}T15:00` }).expect(201);
    const block = blockOf(created.body);
    expect(block).toMatchObject({
      title: "Rendez-vous",
      note: "Médecin",
      start: `${DAY}T14:00`,
      end: `${DAY}T15:00`,
      startsAt: paris(DAY, "14:00"),
      endsAt: paris(DAY, "15:00"),
    });

    expect(blockOf((await request(stack.app).get(`/api/admin/schedule/blocks/${block.id}`).set(admin()).expect(200)).body)).toEqual(block);
    const listed = await request(stack.app).get(`/api/admin/schedule/blocks?from=${DAY}&to=${DAY}`).set(admin()).expect(200);
    expect(z.object({ blocks: z.array(blockSchema) }).parse(listed.body).blocks).toEqual([block]);
    const elsewhere = await request(stack.app).get("/api/admin/schedule/blocks?from=2027-03-04&to=2027-03-05").set(admin()).expect(200);
    expect(z.object({ blocks: z.array(blockSchema) }).parse(elsewhere.body).blocks).toEqual([]);

    const changed = await patchBlock(block.id, { title: "Formation", note: null, end: `${DAY}T15:30` }).expect(200);
    expect(changed.body).toMatchObject({ changed: true, block: { title: "Formation", note: null, end: `${DAY}T15:30`, start: `${DAY}T14:00` } });
    const same = await patchBlock(block.id, { title: "Formation" }).expect(200);
    expect(same.body).toMatchObject({ changed: false });

    expect((await deleteBlock(block.id).expect(200)).body).toEqual({ id: block.id, deleted: true });
    expect((await deleteBlock(block.id).expect(200)).body).toEqual({ id: block.id, deleted: false });
    expect(errorOf((await request(stack.app).get(`/api/admin/schedule/blocks/${block.id}`).set(admin()).expect(404)).body).code).toBe("BLOCK_NOT_FOUND");
    expect(errorOf((await patchBlock(block.id, { title: "x" }).expect(404)).body).code).toBe("BLOCK_NOT_FOUND");
    expect(errorOf((await request(stack.app).get("/api/admin/schedule/blocks/not-a-uuid").set(admin()).expect(404)).body).code).toBe("BLOCK_NOT_FOUND");
  });

  it("a client, a guest or no token cannot read or write blocks; nothing is written", async () => {
    const body = { title: "x", start: `${DAY}T14:00`, end: `${DAY}T15:00` };
    for (const token of [users.clientA, users.guest, users.unverified]) {
      expect((await createBlock(body, nextKey("refused"), bearer(token))).status).toBe(403);
      expect((await request(stack.app).get(`/api/admin/schedule/blocks?from=${DAY}&to=${DAY}`).set(bearer(token))).status).toBe(403);
    }
    expect((await request(stack.app).post("/api/admin/schedule/blocks").set("Idempotency-Key", nextKey("anon")).send(body)).status).toBe(401);
    const id = blockOf((await createBlock(body).expect(201)).body).id;
    expect((await request(stack.app).patch(`/api/admin/schedule/blocks/${id}`).set(bearer(users.clientA)).send({ title: "y" })).status).toBe(403);
    expect((await request(stack.app).delete(`/api/admin/schedule/blocks/${id}`).set(bearer(users.clientA))).status).toBe(403);
    expect(await blockCount()).toBe(1);
  });

  it("writes no outbox events (no emails) and leaves the working hours in the day view", async () => {
    const id = blockOf((await createBlock({ title: "x", start: `${DAY}T14:00`, end: `${DAY}T15:00` }).expect(201)).body).id;
    await patchBlock(id, { end: `${DAY}T16:00` }).expect(200);
    const days = await request(stack.app).get(`/api/admin/schedule/days?from=${DAY}&to=2027-03-04`).set(admin()).expect(200);
    const parsed = z
      .object({
        days: z.array(
          z.object({
            date: z.string(),
            effective: z.object({ open: z.boolean(), intervals: z.array(z.object({ start: z.string(), end: z.string() })) }),
            blocks: z.array(blockSchema),
          }),
        ),
      })
      .parse(days.body).days;
    expect(parsed.map((day) => [day.date, day.effective.intervals, day.blocks.map((block) => block.id)])).toEqual([
      [DAY, [{ start: "09:00", end: "20:30" }], [id]],
      ["2027-03-04", [{ start: "09:00", end: "20:30" }], []],
    ]);
    await deleteBlock(id).expect(200);
    expect(await outboxCount()).toBe(0);
  });
});

describe("availability around a block", () => {
  it("14:00–15:00 keeps a break on both sides; the grid after it starts at 15:15", async () => {
    await createBlock({ title: "x", start: `${DAY}T14:00`, end: `${DAY}T15:00` }).expect(201);
    const slots = await slotsOn(DAY);
    expect(slots).toContain(paris(DAY, "12:45"));
    expect(slots).not.toContain(paris(DAY, "13:00"));
    expect(slots.filter((slot) => slot >= paris(DAY, "12:45") && slot < paris(DAY, "16:00"))).toEqual([
      paris(DAY, "12:45"),
      paris(DAY, "15:15"),
      paris(DAY, "15:30"),
      paris(DAY, "15:45"),
    ]);

    for (const time of ["13:00", "14:30", "15:00"]) {
      const refused = await book(users.clientA, paris(DAY, time));
      expect(refused.status, time).toBe(409);
      expect(refused.body, time).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "taken" });
    }
    await book(users.clientA, paris(DAY, "12:45")).expect(201);
    await book(users.clientB, paris(DAY, "15:15")).expect(201);
  });

  it("the grid after a block ending off the quarter follows its end plus the break", async () => {
    await createBlock({ title: "x", start: `${DAY}T10:00`, end: `${DAY}T11:05` }).expect(201);
    const slots = await slotsOn(DAY);
    expect(slots.filter((slot) => slot >= paris(DAY, "10:00") && slot < paris(DAY, "12:00"))).toEqual([paris(DAY, "11:20"), paris(DAY, "11:35"), paris(DAY, "11:50")]);
    expect((await book(users.clientA, paris(DAY, "11:30"))).body).toMatchObject({ code: "SLOT_UNAVAILABLE" });
    await book(users.clientA, paris(DAY, "11:20")).expect(201);
  });

  it("overlapping blocks merge; a move onto a block is refused; deleting the blocks gives the slots back", async () => {
    const before = await slotsOn(DAY);
    const first = blockOf((await createBlock({ title: "a", start: `${DAY}T10:00`, end: `${DAY}T11:00` }).expect(201)).body).id;
    const second = blockOf((await createBlock({ title: "b", start: `${DAY}T10:30`, end: `${DAY}T12:00` }).expect(201)).body).id;
    const merged = await slotsOn(DAY);
    // Busy 10:00–12:15 as one stretch: nothing fits before it (09:00 + 60 min + break > 10:00), the next start is 12:15.
    expect(merged.filter((slot) => slot >= paris(DAY, "08:00") && slot < paris(DAY, "12:30"))).toEqual([paris(DAY, "12:15")]);

    const id = bookingIdOf(await book(users.clientA, paris(DAY, "16:00")).expect(201));
    const move = await request(stack.app).post(`/api/bookings/${id}/reschedule`).set(bearer(users.clientA)).send({ startsAt: paris(DAY, "11:00") });
    expect(move.status).toBe(409);
    expect(move.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "taken" });

    await deleteBlock(first).expect(200);
    await deleteBlock(second).expect(200);
    await request(stack.app).post(`/api/bookings/${id}/cancel`).set(bearer(users.clientA)).send({}).expect(200);
    expect(await slotsOn(DAY)).toEqual(before);
  });
});

describe("conflicts with confirmed bookings (409 BLOCK_CONFLICT)", () => {
  it("a block may not touch a booking or its break; exactly at the break is allowed; nothing is written", async () => {
    const id = bookingIdOf(await book(users.clientA, paris(DAY, "10:00")).expect(201)); // 10:00–11:00, break to 11:15

    const touching: [string, string][] = [["11:00", "12:00"], ["10:30", "10:45"], ["08:00", "09:50"]];
    for (const [start, end] of touching) {
      const refused = await createBlock({ title: "x", start: `${DAY}T${start}`, end: `${DAY}T${end}` });
      expect(refused.status, `${start}–${end}`).toBe(409);
      expect(refused.body).toMatchObject({
        code: "BLOCK_CONFLICT",
        conflicts: [{ bookingId: id, startsAt: paris(DAY, "10:00"), endsAt: paris(DAY, "11:00"), serviceName: "Massage 60" }],
      });
    }
    expect(await blockCount()).toBe(0);

    await createBlock({ title: "after", start: `${DAY}T11:15`, end: `${DAY}T12:00` }).expect(201);
    const before = blockOf((await createBlock({ title: "before", start: `${DAY}T08:00`, end: `${DAY}T09:45` }).expect(201)).body);

    // Moving a block into the booking is refused and leaves it as it was.
    const moved = await patchBlock(before.id, { end: `${DAY}T10:00` });
    expect(moved.status).toBe(409);
    expect(errorOf(moved.body).code).toBe("BLOCK_CONFLICT");
    expect(blockOf((await request(stack.app).get(`/api/admin/schedule/blocks/${before.id}`).set(admin()).expect(200)).body)).toEqual(before);
    // A cancelled booking is no conflict.
    await request(stack.app).post(`/api/bookings/${id}/cancel`).set(bearer(users.clientA)).send({}).expect(200);
    await patchBlock(before.id, { end: `${DAY}T10:30` }).expect(200);
  });
});

describe("Idempotency-Key", () => {
  it("a repeat returns the block; another body is 422; after a delete a repeat is 410 and creates nothing", async () => {
    const body = { title: "x", start: `${DAY}T14:00`, end: `${DAY}T15:00` };
    const key = nextKey("idem");
    const created = blockOf((await createBlock(body, key).expect(201)).body);
    const replay = await createBlock(body, key).expect(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(blockOf(replay.body)).toEqual(created);
    expect(await blockCount()).toBe(1);

    const reused = await createBlock({ ...body, title: "y" }, key);
    expect(reused.status).toBe(422);
    expect(errorOf(reused.body).code).toBe("IDEMPOTENCY_KEY_REUSED");

    const missing = await request(stack.app).post("/api/admin/schedule/blocks").set(admin()).send(body);
    expect(missing.status).toBe(400);
    expect(errorOf(missing.body).code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    await deleteBlock(created.id).expect(200);
    const afterDelete = await createBlock(body, key);
    expect(afterDelete.status).toBe(410);
    expect(errorOf(afterDelete.body).code).toBe("BLOCK_DELETED");
    expect(await blockCount()).toBe(0);
    expect((await slotsOn(DAY)).includes(paris(DAY, "14:00"))).toBe(true);

    // A new key creates a new block.
    await createBlock(body).expect(201);
  });
});

describe("bounds, duration and DST (Europe/Paris)", () => {
  const status = async (start: string, end: string) => (await createBlock({ title: "x", start, end })).status;

  it("refuses off-grid, too short, too long or too far bounds", async () => {
    expect(await status(`${DAY}T14:02`, `${DAY}T15:00`)).toBe(400);
    expect(await status(`${DAY}T14:00`, `${DAY}T14:10`)).toBe(400);
    expect(await status(`${DAY}T14:00`, `${DAY}T14:00`)).toBe(400);
    expect(await status(`${DAY}T15:00`, `${DAY}T14:00`)).toBe(400);
    expect(await status(`${DAY}T14:00`, "2027-03-04T14:05")).toBe(400);
    expect(await status("2027-02-28T10:00", "2027-02-28T11:00")).toBe(400);
    expect(await status("2028-03-01T10:00", "2028-03-01T11:00")).toBe(400); // today + 366
    expect(await status(`${DAY}T14:00`, `${DAY}T14:15`)).toBe(201);
    expect(await status("2028-02-29T10:00", "2028-02-29T11:00")).toBe(201); // today + 365
  });

  it("a whole local day 00:00–24:00 has 23 or 25 real hours on the change days; 24:00 is the next midnight", async () => {
    const autumn = blockOf((await createBlock({ title: "x", start: "2027-10-31T00:00", end: "2027-10-31T24:00" }).expect(201)).body);
    expect(autumn).toMatchObject({ start: "2027-10-31T00:00", end: "2027-11-01T00:00" });
    expect(Date.parse(autumn.endsAt) - Date.parse(autumn.startsAt)).toBe(25 * 3_600_000);
    const spring = blockOf((await createBlock({ title: "x", start: "2027-03-28T00:00", end: "2027-03-29T00:00" }).expect(201)).body);
    expect(Date.parse(spring.endsAt) - Date.parse(spring.startsAt)).toBe(23 * 3_600_000);
    expect(await status("2027-03-28T00:00", "2027-03-29T00:05")).toBe(400);
  });

  it("local times that do not exist or occur twice on the change days are refused with the field", async () => {
    const gap = await createBlock({ title: "x", start: "2027-03-28T02:30", end: "2027-03-28T04:00" });
    expect(gap.status).toBe(400);
    expect(gap.body).toMatchObject({ code: "VALIDATION_FAILED", errors: [{ field: ["start"] }] });
    const overlap = await createBlock({ title: "x", start: "2027-10-31T01:00", end: "2027-10-31T02:30" });
    expect(overlap.status).toBe(400);
    expect(overlap.body).toMatchObject({ code: "VALIDATION_FAILED", errors: [{ field: ["end"] }] });
    expect(await status("2027-03-28T01:30", "2027-03-28T03:00")).toBe(201);
    expect(await status("2027-10-31T01:00", "2027-10-31T03:00")).toBe(201);
  });
});

describe("v1 rules: one local date, the end in the future", () => {
  const refusedField = (response: request.Response): unknown => {
    expect(response.status).toBe(400);
    return z.object({ code: z.literal("VALIDATION_FAILED"), errors: z.array(z.object({ field: z.array(z.string()) })) }).parse(response.body).errors[0]?.field;
  };

  it("start and end lie on one local date; the end may be 24:00 (or the next date at 00:00), nothing later", async () => {
    expect(blockOf((await createBlock({ title: "x", start: `${DAY}T22:00`, end: `${DAY}T24:00` }).expect(201)).body)).toMatchObject({ end: "2027-03-04T00:00" });
    await createBlock({ title: "x", start: `${DAY}T20:00`, end: "2027-03-04T00:00" }).expect(201);
    for (const end of ["2027-03-04T00:05", "2027-03-04T01:00", "2027-03-04T08:00", "2027-03-05T00:00"]) {
      expect(refusedField(await createBlock({ title: "x", start: `${DAY}T08:00`, end })), end).toEqual(["end"]);
    }
    const id = blockOf((await createBlock({ title: "x", start: "2027-03-05T21:00", end: "2027-03-05T22:00" }).expect(201)).body).id;
    expect(refusedField(await patchBlock(id, { end: "2027-03-06T01:00" }))).toEqual(["end"]);
    expect(refusedField(await patchBlock(id, { start: "2027-03-06T09:00" }))).toEqual(["end"]); // the old end is on the date before
    await patchBlock(id, { end: "2027-03-05T24:00" }).expect(200);
    expect(await blockCount()).toBe(3);
  });

  it("a block must end in the future; today's block that has started but not ended is allowed", async () => {
    // Now is 07:00 in Paris.
    expect(refusedField(await createBlock({ title: "x", start: "2027-03-01T05:00", end: "2027-03-01T06:00" }))).toEqual(["end"]);
    expect(refusedField(await createBlock({ title: "x", start: "2027-03-01T06:00", end: "2027-03-01T07:00" }))).toEqual(["end"]);
    await createBlock({ title: "x", start: "2027-03-01T06:00", end: "2027-03-01T07:15" }).expect(201);
    expect(await blockCount()).toBe(1);
  });

  it("PATCH checks the resulting bounds also for a title or note only: a past block can be read and deleted, not changed", async () => {
    const block = blockOf((await createBlock({ title: "x", note: "n", start: "2027-03-01T08:00", end: "2027-03-01T09:00" }).expect(201)).body);
    stack.setNow("2027-03-01T08:30:00Z"); // 09:30 in Paris: the block has ended
    for (const body of [{ title: "y" }, { note: null }, { title: "x" }, { start: "2027-03-01T08:00" }]) {
      expect(refusedField(await patchBlock(block.id, body)), JSON.stringify(body)).toEqual(["end"]);
    }
    expect(refusedField(await patchBlock(block.id, { start: "2027-02-28T08:00", end: "2027-02-28T09:00" }))).toEqual(["end"]);
    expect(blockOf((await request(stack.app).get(`/api/admin/schedule/blocks/${block.id}`).set(admin()).expect(200)).body)).toEqual(block);
    // Moving it into the future is a change of its bounds and is allowed.
    await patchBlock(block.id, { end: "2027-03-01T10:00" }).expect(200);
    stack.setNow("2027-03-01T09:30:00Z");
    expect((await deleteBlock(block.id).expect(200)).body).toEqual({ id: block.id, deleted: true });
  });
});

describe("race of a block and a booking for the same time (two API instances)", () => {
  it("exactly one of them is written, every round", async () => {
    const [first, second] = stack.apps;
    if (first === undefined || second === undefined) {
      throw new Error("two app instances expected");
    }
    for (let round = 0; round < 6; round += 1) {
      await resetCalendar(stack.db);
      serviceId = await insertService(stack.db, { name: "Massage 60", durationMinutes: 60, priceCents: 6500 });
      await request(first).put("/api/admin/schedule/weekly").set(admin()).send({ intervals: WEEK }).expect(200);

      const blockRequest = createBlock({ title: "race", start: `${DAY}T10:00`, end: `${DAY}T11:00` }, nextKey("race"), admin(), round % 2 === 0 ? first : second);
      const bookingRequest = book(users.clientA, paris(DAY, "10:30"), round % 2 === 0 ? second : first);
      const [blockResponse, bookingResponse] = await Promise.all([blockRequest, bookingRequest]);

      const outcome = [blockResponse.status, bookingResponse.status].sort();
      expect(outcome, `round ${String(round)}`).toEqual([201, 409]);
      if (blockResponse.status === 201) {
        expect(bookingResponse.body).toMatchObject({ code: "SLOT_UNAVAILABLE", reason: "taken" });
      } else {
        expect(blockResponse.body).toMatchObject({ code: "BLOCK_CONFLICT" });
      }
      const blocks = await blockCount();
      const bookings = await countRows(stack.db, `SELECT count(*)::int AS n FROM "Booking" WHERE status = 'confirmed'`);
      expect(blocks + bookings, `round ${String(round)}`).toBe(1);
    }
  });
});
