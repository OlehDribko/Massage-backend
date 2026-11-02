import type { WorkerTuning } from "./config.js";

/**
 * Pause before the next attempt after `attempts` failed temporary ones: the
 * agreed schedule (1 min, then 5 min) plus up to 20 % random jitter, and never
 * earlier than the provider's Retry-After. A Retry-After longer than
 * retryAfterCapMs is not shortened: the worker ends automatic processing
 * instead (retryAfterTooLong).
 */
export const retryDelayMs = (
  attempts: number,
  retryAfterMs: number | null,
  tuning: Pick<WorkerTuning, "retryDelaysMs" | "retryJitterRatio">,
  random: () => number = Math.random,
): number => {
  const scheduled = tuning.retryDelaysMs[Math.min(Math.max(attempts, 1), tuning.retryDelaysMs.length) - 1] ?? 0;
  const jittered = Math.round(scheduled * (1 + random() * tuning.retryJitterRatio));
  return Math.max(jittered, retryAfterMs ?? 0);
};

/** The provider asks to wait longer than we keep a delivery open for automatic retries. */
export const retryAfterTooLong = (retryAfterMs: number | null, tuning: Pick<WorkerTuning, "retryAfterCapMs">): boolean =>
  retryAfterMs !== null && retryAfterMs > tuning.retryAfterCapMs;
