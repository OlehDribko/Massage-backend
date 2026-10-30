import type { WorkerTuning } from "./config.js";

/**
 * Pause before the next attempt after `attempts` failed temporary ones: the
 * agreed schedule (1 min, then 5 min) plus up to 20 % random jitter, and never
 * earlier than the provider's Retry-After (capped, so that all attempts stay
 * inside the provider's idempotency window; see config.ts).
 */
export const retryDelayMs = (
  attempts: number,
  retryAfterMs: number | null,
  tuning: Pick<WorkerTuning, "retryDelaysMs" | "retryJitterRatio" | "retryAfterCapMs">,
  random: () => number = Math.random,
): number => {
  const scheduled = tuning.retryDelaysMs[Math.min(Math.max(attempts, 1), tuning.retryDelaysMs.length) - 1] ?? 0;
  const jittered = Math.round(scheduled * (1 + random() * tuning.retryJitterRatio));
  const providerMinimum = retryAfterMs === null ? 0 : Math.min(retryAfterMs, tuning.retryAfterCapMs);
  return Math.max(jittered, providerMinimum);
};
