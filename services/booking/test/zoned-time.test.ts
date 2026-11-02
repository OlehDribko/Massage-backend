import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  isoWeekday,
  localDateSchema,
  localDateTimeOf,
  localDateTimeToInstant,
  offsetMinutesAt,
} from "../src/modules/schedule/zoned-time.js";

const PARIS = "Europe/Paris";
const at = (date: string, hhmm: string): string => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return localDateTimeToInstant(date, Number(h) * 60 + Number(m), PARIS).toISOString();
};

describe("Europe/Paris wall-clock ↔ instant (no fixed offsets)", () => {
  it("uses +01:00 in winter and +02:00 in summer", () => {
    expect(at("2027-01-15", "09:00")).toBe("2027-01-15T08:00:00.000Z");
    expect(at("2027-07-15", "09:00")).toBe("2027-07-15T07:00:00.000Z");
    expect(offsetMinutesAt(Date.parse("2027-01-15T12:00:00Z"), PARIS)).toBe(60);
    expect(offsetMinutesAt(Date.parse("2027-07-15T12:00:00Z"), PARIS)).toBe(120);
  });

  it("spring forward (2027-03-28, 02:00 → 03:00): offsets change at 01:00Z; a time in the gap moves forward", () => {
    expect(at("2027-03-28", "01:59")).toBe("2027-03-28T00:59:00.000Z");
    expect(at("2027-03-28", "03:00")).toBe("2027-03-28T01:00:00.000Z");
    expect(at("2027-03-28", "09:00")).toBe("2027-03-28T07:00:00.000Z");
    // 02:30 does not exist: like Temporal "compatible", it becomes 03:30 summer time.
    expect(at("2027-03-28", "02:30")).toBe("2027-03-28T01:30:00.000Z");
    expect(localDateTimeOf(new Date("2027-03-28T01:30:00Z"), PARIS)).toEqual({ date: "2027-03-28", minuteOfDay: 210 });
  });

  it("fall back (2027-10-31, 03:00 → 02:00): an ambiguous time maps to the earlier instant", () => {
    expect(at("2027-10-31", "02:30")).toBe("2027-10-31T00:30:00.000Z");
    expect(localDateTimeOf(new Date("2027-10-31T01:30:00Z"), PARIS)).toEqual({ date: "2027-10-31", minuteOfDay: 150 });
    expect(at("2027-10-31", "09:00")).toBe("2027-10-31T08:00:00.000Z");
    expect(at("2027-10-30", "09:00")).toBe("2027-10-30T07:00:00.000Z");
  });

  it("24:00 is the next local midnight; a day has 23 or 25 hours on transition days", () => {
    expect(at("2027-03-27", "24:00")).toBe(at("2027-03-28", "00:00"));
    const spring = Date.parse(at("2027-03-29", "00:00")) - Date.parse(at("2027-03-28", "00:00"));
    const autumn = Date.parse(at("2027-11-01", "00:00")) - Date.parse(at("2027-10-31", "00:00"));
    expect(spring / 3_600_000).toBe(23);
    expect(autumn / 3_600_000).toBe(25);
  });

  it("local dates: weekday, adding days across months and years, calendar validation", () => {
    expect(isoWeekday("2027-03-01")).toBe(1);
    expect(isoWeekday("2027-03-07")).toBe(7);
    expect(addDays("2027-12-20", 45)).toBe("2028-02-03");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(daysBetween("2027-03-01", "2027-04-15")).toBe(45);
    expect(localDateSchema.safeParse("2027-02-29").success).toBe(false);
    expect(localDateSchema.safeParse("2028-02-29").success).toBe(true);
    expect(localDateSchema.safeParse("2027-3-1").success).toBe(false);
  });
});
