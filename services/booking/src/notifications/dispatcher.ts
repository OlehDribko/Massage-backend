import { describeError, type Logger } from "../logging/logger.js";
import type { PassResult } from "./worker.js";

/**
 * Runs notification passes inside the API process, only when there is a
 * reason to:
 * - wake(): after every booking write (success or failure, see bootstrap.ts);
 * - start(): once at process start, to pick up work left by a stopped process;
 * - one timer for the next concrete unfinished delivery (a retry time or
 *   another process's lease expiry), recomputed from the database after each
 *   pass.
 * With no unfinished work there is no timer and no database access: no
 * polling loop. A pass that fails (e.g. database unavailable) is retried a
 * bounded number of times, then the dispatcher waits for the next wake or
 * restart (docs/notifications.md, "Відновлення").
 */
export type Timers = {
  /** Calls `callback` once after `delayMs`; returns a function that cancels it. */
  schedule: (callback: () => void, delayMs: number) => () => void;
};

/** Node timers that never keep the process alive on their own. */
export const realTimers: Timers = {
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => {
      clearTimeout(timer);
    };
  },
};

export type NextWork = { at: Date | null; unplanned: boolean };

export type Dispatcher = {
  /** Requests a pass; a pass already running is followed by one more. */
  wake: () => void;
  /** Start-up recovery pass. */
  start: () => void;
  /** No new passes or timers; waits for the running pass (its email in flight). */
  stop: () => Promise<void>;
  /** Resolves when no pass is running. */
  idle: () => Promise<void>;
  /** When the single timer fires, or null when none is set. */
  scheduledAt: () => Date | null;
};

export const DEFAULT_FAILURE_RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000];

/** Smallest timer delay; also the pause before re-checking work that was due but not claimable. */
const MIN_TIMER_MS = 1_000;
/** setTimeout's limit (about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;
/** Passes in a row that find due work but cannot take it before the dispatcher stops re-checking. */
const MAX_IDLE_RECHECKS = 3;

export const createDispatcher = ({
  tick,
  nextWorkAt,
  stopWorker,
  logger,
  now = () => new Date(),
  timers = realTimers,
  failureRetryMs = DEFAULT_FAILURE_RETRY_MS,
}: {
  tick: () => Promise<PassResult>;
  nextWorkAt: () => Promise<NextWork>;
  stopWorker: () => void;
  logger: Logger;
  now?: () => Date;
  timers?: Timers;
  failureRetryMs?: number[];
}): Dispatcher => {
  let requested = 0;
  let seen = 0;
  let running: Promise<void> | undefined;
  let cancelTimer: (() => void) | undefined;
  let timerAt: Date | null = null;
  let failures = 0;
  let idleRechecks = 0;
  let stopping = false;

  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = undefined;
    timerAt = null;
  };

  const arm = (delayMs: number) => {
    clearTimer();
    if (stopping) {
      return; // a pass that finishes after stop() leaves no timer behind
    }
    const delay = Math.min(Math.max(delayMs, MIN_TIMER_MS), MAX_TIMER_MS);
    timerAt = new Date(now().getTime() + delay);
    cancelTimer = timers.schedule(() => {
      cancelTimer = undefined;
      timerAt = null;
      wake();
    }, delay);
  };

  const pass = async () => {
    const result = await tick();
    const next = await nextWorkAt();
    failures = 0;
    const due = next.unplanned ? now() : next.at;
    if (due === null) {
      idleRechecks = 0;
      return; // nothing unfinished: no timer
    }
    const delay = due.getTime() - now().getTime();
    if (delay > 0) {
      idleRechecks = 0;
      arm(delay);
      return;
    }
    // Due now but this pass could not take it (e.g. planned or leased by
    // another process at the same moment). Re-check a few times, then wait.
    idleRechecks = result.planned + result.handled > 0 ? 0 : idleRechecks + 1;
    if (idleRechecks > MAX_IDLE_RECHECKS) {
      idleRechecks = 0;
      logger.warn("notification work is due but could not be taken; waiting for the next booking change or restart");
      return;
    }
    arm(MIN_TIMER_MS);
  };

  const loop = async () => {
    while (!stopping && seen !== requested) {
      seen = requested;
      clearTimer();
      try {
        await pass();
      } catch (error) {
        const retryIn = failureRetryMs[failures];
        if (retryIn === undefined) {
          failures = 0;
          logger.error(
            { error: describeError(error) },
            "notifications pass failed; waiting for the next booking change or restart",
          );
        } else {
          failures += 1;
          logger.error({ error: describeError(error), retryInMs: retryIn }, "notifications pass failed");
          arm(retryIn);
        }
      }
    }
  };

  const ensureRunning = () => {
    if (running !== undefined || stopping) {
      return;
    }
    running = (async () => {
      try {
        await loop();
      } finally {
        running = undefined;
        // A wake() between the loop's last check and here must not be lost.
        if (!stopping && seen !== requested) {
          ensureRunning();
        }
      }
    })();
  };

  const wake = () => {
    if (stopping) {
      return;
    }
    requested += 1;
    ensureRunning();
  };

  const idle = async () => {
    while (running !== undefined) {
      await running;
    }
  };

  return {
    wake,
    start: () => {
      logger.info("notifications dispatcher started");
      wake();
    },
    stop: async () => {
      stopping = true;
      clearTimer();
      stopWorker();
      await idle();
    },
    idle,
    scheduledAt: () => timerAt,
  };
};
