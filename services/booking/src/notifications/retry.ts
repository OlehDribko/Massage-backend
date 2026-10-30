import type { WorkerTuning } from "./config.js";

/**
 * Delay before the next attempt after `attempts` failed ones: exponential
 * (base × 2^(attempts−1), capped) with "equal jitter" (half fixed, half
 * random, so concurrent failures spread out), and never earlier than the
 * provider's Retry-After (itself capped).
 */
export const retryDelayMs = (
  attempts: number,
  retryAfterMs: number | null,
  tuning: Pick<WorkerTuning, "retryBaseMs" | "retryCapMs" | "retryAfterCapMs">,
  random: () => number = Math.random,
): number => {
  const exponential = Math.min(tuning.retryCapMs, tuning.retryBaseMs * 2 ** Math.max(0, attempts - 1));
  const jittered = Math.round(exponential / 2 + random() * (exponential / 2));
  const providerMinimum = retryAfterMs === null ? 0 : Math.min(retryAfterMs, tuning.retryAfterCapMs);
  return Math.max(jittered, providerMinimum);
};
