import { describe, expect, it } from "vitest";
import { cancellationAllowed, phaseOf, rescheduleAllowed } from "../src/modules/bookings/booking.rules.js";
import { DEFAULT_BOOKING_RULES as RULES } from "../src/modules/schedule/booking-rules.js";
import { scheduleExceptionSchema, weeklyScheduleSchema } from "../src/modules/schedule/schedule.schema.js";
import {
  bookingWindow,
  daySlots,
  fitsWorkingIntervals,
  type MinuteInterval,
  type OccupiedTime,
} from "../src/modules/schedule/slots.js";
import { localDateTimeToInstant } from "../src/modules/schedule/zoned-time.js";

const PARIS = "Europe/Paris";
const local = (date: string, hhmm: string): Date => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return localDateTimeToInstant(date, Number(h) * 60 + Number(m), PARIS);
};
const iv = (from: string, to: string): MinuteInterval => {
  const minutes = (value: string) => {
    const [h = "0", m = "0"] = value.split(":");
    return Number(h) * 60 + Number(m);
  };
  return { startMinute: minutes(from), endMinute: minutes(to) };
};
const occupied = (date: string, from: string, durationMinutes: number): OccupiedTime => {
  const startsAt = local(date, from);
  return { startsAt, blockedUntil: new Date(startsAt.getTime() + (durationMinutes + RULES.breakMinutes) * 60_000) };
};
const localStarts = (_date: string, slots: { startsAt: Date }[]): string[] =>
  slots.map((slot) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: PARIS, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(slot.startsAt),
  );

// "now" far enough before the dates used so lead time and horizon do not interfere.
const NOW = new Date("2027-03-01T06:00:00Z");
const WINDOW = bookingWindow(NOW, RULES);
const slotsOf = (date: string, intervals: MinuteInterval[], durationMinutes: number, taken: OccupiedTime[] = []) =>
  localStarts(date, daySlots({ date, intervals, durationMinutes, occupied: taken, window: WINDOW, rules: RULES }));

describe("possible starts (15-minute grid, session fits the interval, latest start 19:00)", () => {
  it("steps every 15 minutes from the interval start; the session must end inside the interval", () => {
    expect(slotsOf("2027-03-02", [iv("09:00", "10:30")], 60)).toEqual(["09:00", "09:15", "09:30"]);
    // Grid follows the interval start.
    expect(slotsOf("2027-03-02", [iv("09:10", "10:40")], 60)).toEqual(["09:10", "09:25", "09:40"]);
  });

  it("never offers a start after 19:00, whatever the interval or duration", () => {
    const evening = slotsOf("2027-03-02", [iv("18:00", "22:00")], 90);
    expect(evening.at(-1)).toBe("19:00");
    expect(evening).not.toContain("19:15");
    // 90 minutes at 19:00 ends at 20:30: offered only if the interval reaches 20:30.
    expect(slotsOf("2027-03-02", [iv("18:00", "20:00")], 90).at(-1)).toBe("18:30");
    expect(slotsOf("2027-03-02", [iv("18:00", "20:30")], 90).at(-1)).toBe("19:00");
  });

  it("does not run into a lunch break between intervals", () => {
    const day = slotsOf("2027-03-02", [iv("09:00", "13:00"), iv("14:00", "18:00")], 60);
    expect(day).toContain("12:00");
    expect(day).not.toContain("12:15");
    expect(day).toContain("14:00");
  });

  it("keeps a 20-minute break before and after another booking (but not after the last session)", () => {
    // Booked 10:00–11:00: occupied (with its break) until 11:20.
    const day = slotsOf("2027-03-02", [iv("08:00", "13:00")], 60, [occupied("2027-03-02", "10:00", 60)]);
    // Before: a session must end by 09:40 (its own break ends by 10:00) → last start 08:30.
    expect(day.slice(0, 3)).toEqual(["08:00", "08:15", "08:30"]);
    expect(day).not.toContain("08:45");
    expect(day).not.toContain("09:00");
    // After: not before 11:20; on the 15-minute grid the next start is 11:30.
    expect(day).not.toContain("11:15");
    expect(day[3]).toBe("11:30");
    // The last session may end exactly at the interval end (no break needed after it).
    expect(day.at(-1)).toBe("12:00");
  });

  it("an empty day (day off) has no starts", () => {
    expect(slotsOf("2027-03-02", [], 60)).toEqual([]);
  });

  it("handles daylight saving days with real offsets", () => {
    const spring = daySlots({ date: "2027-03-28", intervals: [iv("09:00", "10:00")], durationMinutes: 60, occupied: [], window: bookingWindow(new Date("2027-03-20T00:00:00Z"), RULES), rules: RULES });
    expect(spring.map((slot) => slot.startsAt.toISOString())).toEqual(["2027-03-28T07:00:00.000Z"]);
    const autumn = daySlots({ date: "2027-10-31", intervals: [iv("09:00", "10:00")], durationMinutes: 60, occupied: [], window: bookingWindow(new Date("2027-10-20T00:00:00Z"), RULES), rules: RULES });
    expect(autumn.map((slot) => slot.startsAt.toISOString())).toEqual(["2027-10-31T08:00:00.000Z"]);
    // An interval over the spring gap (01:00–04:00 local) lasts 2 real hours.
    const gap = daySlots({ date: "2027-03-28", intervals: [iv("01:00", "04:00")], durationMinutes: 60, occupied: [], window: bookingWindow(new Date("2027-03-20T00:00:00Z"), { ...RULES, slotStepMinutes: 60 }), rules: { ...RULES, slotStepMinutes: 60 } });
    expect(gap.map((slot) => slot.startsAt.toISOString())).toEqual(["2027-03-28T00:00:00.000Z", "2027-03-28T01:00:00.000Z"]);
  });
});

describe("minimum lead time (12 h) and horizon (end of local day today + 45)", () => {
  it("a start exactly 12 h from now is allowed; one minute earlier is not", () => {
    const now = new Date("2027-03-02T06:00:00Z"); // 07:00 Paris
    const window = bookingWindow(now, RULES);
    expect(window.earliestStart.toISOString()).toBe("2027-03-02T18:00:00.000Z"); // 19:00 Paris
    const starts = daySlots({ date: "2027-03-02", intervals: [iv("18:30", "21:00")], durationMinutes: 60, occupied: [], window, rules: RULES });
    expect(localStarts("2027-03-02", starts)).toEqual(["19:00"]);
    const later = bookingWindow(new Date(now.getTime() + 60_000), RULES);
    expect(daySlots({ date: "2027-03-02", intervals: [iv("18:30", "21:00")], durationMinutes: 60, occupied: [], window: later, rules: RULES })).toEqual([]);
  });

  it("allows starts until the end of the local day today + 45, never the day after", () => {
    const now = new Date("2027-03-01T22:30:00Z"); // 23:30 Paris on 03-01
    const window = bookingWindow(now, RULES);
    expect(window.today).toBe("2027-03-01");
    expect(window.lastDate).toBe("2027-04-15");
    expect(window.horizonEnd.toISOString()).toBe(local("2027-04-16", "00:00").toISOString());
    const last = daySlots({ date: "2027-04-15", intervals: [iv("09:00", "10:00")], durationMinutes: 60, occupied: [], window, rules: RULES });
    expect(last).toHaveLength(1);
    const after = daySlots({ date: "2027-04-16", intervals: [iv("09:00", "10:00")], durationMinutes: 60, occupied: [], window, rules: RULES });
    expect(after).toEqual([]);
  });
});

describe("existing booking rules", () => {
  const start = new Date("2027-03-10T09:00:00Z");
  const minus = (ms: number) => new Date(start.getTime() - ms);
  const H12 = 12 * 3_600_000;

  it("rescheduling needs strictly more than 12 h; exactly 12 h is too late", () => {
    expect(rescheduleAllowed(start, minus(H12 + 1), RULES)).toBe(true);
    expect(rescheduleAllowed(start, minus(H12), RULES)).toBe(false);
    expect(rescheduleAllowed(start, minus(H12 - 1), RULES)).toBe(false);
  });

  it("cancelling is allowed until the start, even a minute before, never from the start on", () => {
    expect(cancellationAllowed(start, minus(60_000))).toBe(true);
    expect(cancellationAllowed(start, minus(1))).toBe(true);
    expect(cancellationAllowed(start, start)).toBe(false);
    expect(cancellationAllowed(start, new Date(start.getTime() + 1))).toBe(false);
  });

  it("phase is derived from the clock", () => {
    const booking: { status: "confirmed" | "cancelled"; startsAt: Date; endsAt: Date } = {
      status: "confirmed",
      startsAt: start,
      endsAt: new Date(start.getTime() + 3_600_000),
    };
    expect(phaseOf(booking, minus(1))).toBe("upcoming");
    expect(phaseOf(booking, start)).toBe("in_progress");
    expect(phaseOf(booking, booking.endsAt)).toBe("finished");
    expect(phaseOf({ ...booking, status: "cancelled" }, minus(1))).toBe("cancelled");
  });

  it("a booking fits the schedule only inside one working interval", () => {
    const booking = { startsAt: local("2027-03-02", "12:30"), endsAt: local("2027-03-02", "13:30") };
    expect(fitsWorkingIntervals(booking, "2027-03-02", [iv("09:00", "14:00")], PARIS)).toBe(true);
    expect(fitsWorkingIntervals(booking, "2027-03-02", [iv("09:00", "13:00"), iv("13:00", "18:00")], PARIS)).toBe(false);
    expect(fitsWorkingIntervals(booking, "2027-03-02", [], PARIS)).toBe(false);
  });
});

describe("schedule input validation", () => {
  it("accepts HH:MM up to 24:00 and rejects overlaps and reversed intervals", () => {
    const ok = weeklyScheduleSchema.safeParse({ intervals: [{ weekday: 1, start: "09:00", end: "13:00" }, { weekday: 1, start: "14:00", end: "24:00" }] });
    expect(ok.success && ok.data).toEqual([
      { weekday: 1, startMinute: 540, endMinute: 780 },
      { weekday: 1, startMinute: 840, endMinute: 1440 },
    ]);
    expect(weeklyScheduleSchema.safeParse({ intervals: [{ weekday: 1, start: "09:00", end: "13:00" }, { weekday: 1, start: "12:00", end: "15:00" }] }).success).toBe(false);
    expect(weeklyScheduleSchema.safeParse({ intervals: [{ weekday: 8, start: "09:00", end: "13:00" }] }).success).toBe(false);
    expect(weeklyScheduleSchema.safeParse({ intervals: [{ weekday: 1, start: "13:00", end: "09:00" }] }).success).toBe(false);
    expect(weeklyScheduleSchema.safeParse({ intervals: [{ weekday: 1, start: "24:30", end: "25:00" }] }).success).toBe(false);
  });

  it("an exception is either a day off or its own intervals", () => {
    const closed = scheduleExceptionSchema.safeParse({ closed: true });
    expect(closed.success && closed.data).toEqual([]);
    const custom = scheduleExceptionSchema.safeParse({ intervals: [{ start: "10:00", end: "12:00" }] });
    expect(custom.success && custom.data).toEqual([{ startMinute: 600, endMinute: 720 }]);
    expect(scheduleExceptionSchema.safeParse({ intervals: [] }).success).toBe(false);
    expect(scheduleExceptionSchema.safeParse({ closed: false }).success).toBe(false);
  });
});
