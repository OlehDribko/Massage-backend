/**
 * Domain configuration of the booking calendar. Values live here (not in
 * env, no admin API in this stage); services receive them as a dependency so
 * tests can vary them. Agreed with the owner on 2026-10-30 (break and grid
 * revised the same day: one 15-minute break, grid from the end of the break); see
 * docs/booking.md, "Правила часу".
 */
export type BookingRules = {
  /** IANA time zone of the studio; weekly rules and exceptions are local to it. */
  timeZone: string;
  /**
   * The one rest break between two consecutive sessions, minutes: the next
   * session starts at least this long after the previous one ends (one
   * break, not one before plus one after). The session itself must fit in a
   * working interval; the break after the last session of an interval need not.
   */
  breakMinutes: number;
  /** A new start (booking or rescheduling) must be at least this far from now, minutes. */
  minLeadMinutes: number;
  /** Starts allowed up to the end of the local day `today + horizonDays`. */
  horizonDays: number;
  /**
   * Possible starts: every N minutes from the start of a free stretch (the
   * interval start, or the end of the previous session plus its break).
   */
  slotStepMinutes: number;
  /** No session starts later than this local time, minutes since midnight (inclusive). */
  latestStartMinuteOfDay: number;
  /** Rescheduling allowed only while strictly more than this remains before the start, minutes. */
  rescheduleCutoffMinutes: number;
};

export const DEFAULT_BOOKING_RULES: BookingRules = {
  timeZone: "Europe/Paris",
  breakMinutes: 15,
  minLeadMinutes: 12 * 60,
  horizonDays: 45,
  slotStepMinutes: 15,
  latestStartMinuteOfDay: 19 * 60,
  rescheduleCutoffMinutes: 12 * 60,
};
