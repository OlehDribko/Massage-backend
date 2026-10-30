/**
 * Domain configuration of the booking calendar. Values live here (not in
 * env, no admin API in this stage); services receive them as a dependency so
 * tests can vary them. Agreed with the owner on 2026-10-30; see
 * docs/booking.md, "Правила часу".
 */
export type BookingRules = {
  /** IANA time zone of the studio; weekly rules and exceptions are local to it. */
  timeZone: string;
  /**
   * Break required between two sessions, minutes. Needed only before a
   * following session: the session itself must fit in a working interval,
   * the break after the last session of an interval need not.
   */
  breakMinutes: number;
  /** A new start (booking or rescheduling) must be at least this far from now, minutes. */
  minLeadMinutes: number;
  /** Starts allowed up to the end of the local day `today + horizonDays`. */
  horizonDays: number;
  /** Possible starts: every N minutes from the start of a working interval. */
  slotStepMinutes: number;
  /** No session starts later than this local time, minutes since midnight (inclusive). */
  latestStartMinuteOfDay: number;
  /** Rescheduling allowed only while strictly more than this remains before the start, minutes. */
  rescheduleCutoffMinutes: number;
};

export const DEFAULT_BOOKING_RULES: BookingRules = {
  timeZone: "Europe/Paris",
  breakMinutes: 20,
  minLeadMinutes: 12 * 60,
  horizonDays: 45,
  slotStepMinutes: 15,
  latestStartMinuteOfDay: 19 * 60,
  rescheduleCutoffMinutes: 12 * 60,
};
