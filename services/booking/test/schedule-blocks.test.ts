import { describe, expect, it } from "vitest";
import { DEFAULT_BOOKING_RULES as RULES } from "../src/modules/schedule/booking-rules.js";
import { createBlockSchema, updateBlockSchema } from "../src/modules/schedule/schedule-block.schema.js";
import { bookingWindow, daySlots, type MinuteInterval, type OccupiedTime } from "../src/modules/schedule/slots.js";
import { localDateTimeToInstant, resolveLocalDateTime } from "../src/modules/schedule/zoned-time.js";

// Pure rules of calendar blocks: how a block occupies time for the slots
// (the same OccupiedTime as a booking: break after it, and the slot rule
// keeps a break before it), DST handling of entered local times, and the
// request schemas. Database behaviour is in test/integration/schedule-blocks.test.ts.

const PARIS = "Europe/Paris";
const local = (date: string, hhmm: string): Date => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return localDateTimeToInstant(date, Number(h) * 60 + Number(m), PARIS);
};
const minutes = (value: string): number => {
  const [h = "0", m = "0"] = value.split(":");
  return Number(h) * 60 + Number(m);
};
const iv = (from: string, to: string): MinuteInterval => ({ startMinute: minutes(from), endMinute: minutes(to) });
/** A block as availability sees it: its own time plus one break after it. */
const block = (date: string, from: string, to: string): OccupiedTime => ({
  startsAt: local(date, from),
  blockedUntil: new Date(local(date, to).getTime() + RULES.breakMinutes * 60_000),
});
const hhmm = (instant: Date): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: PARIS, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);

const WINDOW = bookingWindow(new Date("2027-03-01T06:00:00Z"), RULES);
const slotsOf = (date: string, durationMinutes: number, taken: OccupiedTime[], intervals = [iv("09:00", "20:30")]) =>
  daySlots({ date, intervals, durationMinutes, occupied: taken, window: WINDOW, rules: RULES }).map((slot) => hhmm(slot.startsAt));

describe("a block in the slots", () => {
  it("14:00–15:00: the session before may end at 13:45, the next one starts at 15:15", () => {
    const starts = slotsOf("2027-03-02", 60, [block("2027-03-02", "14:00", "15:00")]);
    // 12:45 + 60 min = 13:45, plus the 15-minute break = 14:00.
    expect(starts).toContain("12:45");
    expect(starts).not.toContain("13:00");
    expect(starts.filter((start) => start >= "12:45" && start < "16:00")).toEqual(["12:45", "15:15", "15:30", "15:45"]);
  });

  it("the grid after a block starts at its end plus the break, not on the round quarter", () => {
    const starts = slotsOf("2027-03-02", 30, [block("2027-03-02", "10:00", "11:05")]);
    expect(starts.filter((start) => start >= "11:00" && start < "12:00")).toEqual(["11:20", "11:35", "11:50"]);
  });

  it("overlapping blocks merge into one busy stretch", () => {
    const merged = slotsOf("2027-03-02", 30, [block("2027-03-02", "10:00", "11:00"), block("2027-03-02", "10:30", "12:00")]);
    const single = slotsOf("2027-03-02", 30, [block("2027-03-02", "10:00", "12:00")]);
    expect(merged).toEqual(single);
    expect(merged.filter((start) => start >= "09:00" && start < "12:30")).toEqual(["09:00", "09:15", "12:15"]);
  });

  it("a block next to a booking keeps one break between them and takes nothing else", () => {
    const booking: OccupiedTime = { startsAt: local("2027-03-02", "09:00"), blockedUntil: local("2027-03-02", "10:15") };
    const starts = slotsOf("2027-03-02", 60, [booking, block("2027-03-02", "11:30", "12:00")]);
    // 10:15 + 60 min + break = 11:30, the block's start; 10:30 would end too late.
    expect(starts.filter((start) => start < "12:30")).toEqual(["10:15", "12:15"]);
  });

  it("a whole-day block leaves the day empty", () => {
    expect(slotsOf("2027-03-02", 30, [block("2027-03-02", "00:00", "24:00")])).toEqual([]);
  });
});

describe("local times entered for a block (Europe/Paris)", () => {
  it("an ordinary time is exactly one instant", () => {
    expect(resolveLocalDateTime("2027-03-02", minutes("14:00"), PARIS)).toEqual({ kind: "exact", instant: new Date("2027-03-02T13:00:00Z") });
    expect(resolveLocalDateTime("2027-07-02", minutes("14:00"), PARIS)).toEqual({ kind: "exact", instant: new Date("2027-07-02T12:00:00Z") });
  });

  it("02:00–02:55 on the spring change does not exist; 03:00 does", () => {
    expect(resolveLocalDateTime("2027-03-28", minutes("02:00"), PARIS)).toEqual({ kind: "nonexistent" });
    expect(resolveLocalDateTime("2027-03-28", minutes("02:55"), PARIS)).toEqual({ kind: "nonexistent" });
    expect(resolveLocalDateTime("2027-03-28", minutes("03:00"), PARIS)).toEqual({ kind: "exact", instant: new Date("2027-03-28T01:00:00Z") });
  });

  it("02:00–02:55 on the autumn change occurs twice; 03:00 once", () => {
    expect(resolveLocalDateTime("2027-10-31", minutes("02:00"), PARIS)).toEqual({ kind: "ambiguous" });
    expect(resolveLocalDateTime("2027-10-31", minutes("02:55"), PARIS)).toEqual({ kind: "ambiguous" });
    expect(resolveLocalDateTime("2027-10-31", minutes("03:00"), PARIS)).toEqual({ kind: "exact", instant: new Date("2027-10-31T02:00:00Z") });
    expect(resolveLocalDateTime("2027-10-31", minutes("01:55"), PARIS)).toEqual({ kind: "exact", instant: new Date("2027-10-30T23:55:00Z") });
  });
});

describe("block request schemas", () => {
  it("parses local bounds; 24:00 is the next midnight; title and note are trimmed, an empty note is none", () => {
    const parsed = createBlockSchema.parse({ title: "  Rendez-vous  ", note: "  ", start: "2027-03-02T14:00", end: "2027-03-02T24:00" });
    expect(parsed).toEqual({
      title: "Rendez-vous",
      note: null,
      start: { date: "2027-03-02", minuteOfDay: 14 * 60 },
      end: { date: "2027-03-03", minuteOfDay: 0 },
    });
    expect(createBlockSchema.parse({ title: "x", start: "2027-02-28T23:55", end: "2027-03-01T00:30" }).note).toBeNull();
  });

  it("refuses bounds off the 5-minute grid, with an offset, 24:00 as a start, or impossible dates and times", () => {
    const bad = (start: string, end = "2027-03-02T15:00") => createBlockSchema.safeParse({ title: "x", start, end }).success;
    expect(bad("2027-03-02T14:03")).toBe(false);
    expect(bad("2027-03-02T14:00Z")).toBe(false);
    expect(bad("2027-03-02T14:00:00")).toBe(false);
    expect(bad("2027-03-02T24:00")).toBe(false);
    expect(bad("2027-02-30T14:00")).toBe(false);
    expect(bad("2027-03-02T25:00")).toBe(false);
    expect(createBlockSchema.safeParse({ title: "x", start: "2027-03-02T14:00", end: "2027-03-02T24:05" }).success).toBe(false);
  });

  it("title is required (1–100), note at most 500, no unknown fields", () => {
    const base = { start: "2027-03-02T14:00", end: "2027-03-02T15:00" };
    expect(createBlockSchema.safeParse({ ...base }).success).toBe(false);
    expect(createBlockSchema.safeParse({ ...base, title: "   " }).success).toBe(false);
    expect(createBlockSchema.safeParse({ ...base, title: "x".repeat(101) }).success).toBe(false);
    expect(createBlockSchema.safeParse({ ...base, title: "x", note: "n".repeat(501) }).success).toBe(false);
    expect(createBlockSchema.safeParse({ ...base, title: "x", startsAt: "2027-03-02T13:00:00Z" }).success).toBe(false);
  });

  it("an update takes any of the fields, at least one; note null removes the note", () => {
    expect(updateBlockSchema.parse({ note: null })).toEqual({ note: null });
    expect(updateBlockSchema.parse({ end: "2027-03-02T24:00" })).toEqual({ end: { date: "2027-03-03", minuteOfDay: 0 } });
    expect(updateBlockSchema.safeParse({}).success).toBe(false);
    expect(updateBlockSchema.safeParse({ id: "x" }).success).toBe(false);
  });
});
