import { describe, expect, it } from "vitest";
import { createDispatcher, type NextWork, type Timers } from "../src/notifications/dispatcher.js";
import type { PassResult } from "../src/notifications/worker.js";
import { createCapturingLogger } from "./helpers/logs.js";

// The dispatcher with fake passes and a fake clock: when does it touch the
// database (tick / nextWorkAt) and when does it set a timer?

const createHarness = (options: { failureRetryMs?: number[] } = {}) => {
  let clock = Date.parse("2027-03-01T07:00:00Z");
  const pending: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const timers: Timers = {
    schedule: (callback, delayMs) => {
      const entry = { at: clock + delayMs, callback, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };

  const calls = { tick: 0, nextWorkAt: 0 };
  let results: PassResult = { planned: 0, handled: 0 };
  let next: NextWork = { at: null, unplanned: false };
  let failNext = 0;
  let gate: Promise<void> | undefined;

  const logs = createCapturingLogger();
  const dispatcher = createDispatcher({
    tick: async () => {
      calls.tick += 1;
      if (gate !== undefined) {
        await gate;
      }
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("database unavailable");
      }
      return results;
    },
    nextWorkAt: () => {
      calls.nextWorkAt += 1;
      return Promise.resolve(next);
    },
    stopWorker: () => undefined,
    logger: logs.logger,
    now: () => new Date(clock),
    timers,
    ...(options.failureRetryMs === undefined ? {} : { failureRetryMs: options.failureRetryMs }),
  });

  /** Moves the clock, firing due timers in order, and lets their passes finish. */
  const advance = async (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const due = pending.filter((entry) => !entry.cancelled && entry.at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) {
        break;
      }
      due.cancelled = true;
      clock = due.at;
      due.callback();
      await dispatcher.idle();
    }
    clock = until;
  };

  return {
    dispatcher,
    calls,
    logs,
    advance,
    activeTimers: () => pending.filter((entry) => !entry.cancelled).length,
    setResult: (value: PassResult) => {
      results = value;
    },
    setNext: (value: NextWork) => {
      next = value;
    },
    failPasses: (count: number) => {
      failNext = count;
    },
    hold: () => {
      let release: () => void = () => undefined;
      gate = new Promise((resolve) => {
        release = () => {
          gate = undefined;
          resolve();
        };
      });
      return release;
    },
    at: (offsetMs: number) => new Date(clock + offsetMs),
  };
};

describe("notifications dispatcher", () => {
  it("with no unfinished work: one start-up pass, then no timer and no database access at all", async () => {
    const h = createHarness();
    h.dispatcher.start();
    await h.dispatcher.idle();
    expect(h.calls).toEqual({ tick: 1, nextWorkAt: 1 });
    expect(h.dispatcher.scheduledAt()).toBeNull();
    expect(h.activeTimers()).toBe(0);

    await h.advance(7 * 24 * 3_600_000); // a quiet week
    expect(h.calls).toEqual({ tick: 1, nextWorkAt: 1 });
  });

  it("a booking write wakes it; afterwards it is idle again", async () => {
    const h = createHarness();
    h.dispatcher.wake();
    await h.dispatcher.idle();
    h.dispatcher.wake();
    await h.dispatcher.idle();
    expect(h.calls.tick).toBe(2);
    expect(h.activeTimers()).toBe(0);
  });

  it("sets one timer for the next concrete retry, runs it, then stops when the work is done", async () => {
    const h = createHarness();
    const retryAt = h.at(60_000);
    h.setResult({ planned: 1, handled: 2 });
    h.setNext({ at: retryAt, unplanned: false });
    h.dispatcher.wake();
    await h.dispatcher.idle();
    expect(h.dispatcher.scheduledAt()).toEqual(retryAt);
    expect(h.activeTimers()).toBe(1);

    h.setNext({ at: null, unplanned: false });
    await h.advance(59_000);
    expect(h.calls.tick).toBe(1);
    await h.advance(1_000);
    expect(h.calls.tick).toBe(2);
    expect(h.dispatcher.scheduledAt()).toBeNull();
    await h.advance(24 * 3_600_000);
    expect(h.calls.tick).toBe(2);
  });

  it("a wake during a running pass is not lost: exactly one more pass follows", async () => {
    const h = createHarness();
    const release = h.hold();
    h.dispatcher.wake();
    await Promise.resolve();
    h.dispatcher.wake(); // e.g. a booking committed while the pass sends an email
    h.dispatcher.wake();
    release();
    await h.dispatcher.idle();
    expect(h.calls.tick).toBe(2);
  });

  it("a failing pass (database unavailable) is retried a bounded number of times, then it waits", async () => {
    const h = createHarness({ failureRetryMs: [30_000, 120_000] });
    h.failPasses(10);
    h.dispatcher.wake();
    await h.dispatcher.idle();
    await h.advance(30_000);
    await h.advance(120_000);
    expect(h.calls.tick).toBe(3);
    expect(h.activeTimers()).toBe(0);
    await h.advance(24 * 3_600_000);
    expect(h.calls.tick).toBe(3);
    expect(h.logs.raw()).toContain("waiting for the next booking change or restart");
  });

  it("work that is due but cannot be taken is re-checked a few times, not in a loop", async () => {
    const h = createHarness();
    h.setNext({ at: h.at(-1_000), unplanned: false });
    h.dispatcher.wake();
    await h.dispatcher.idle();
    await h.advance(60_000);
    expect(h.calls.tick).toBeLessThanOrEqual(5);
    expect(h.activeTimers()).toBe(0);
    expect(h.logs.raw()).toContain("could not be taken");
  });

  it("stop: no new passes or timers, the running pass is finished first", async () => {
    const h = createHarness();
    h.setNext({ at: h.at(60_000), unplanned: false });
    const release = h.hold();
    h.dispatcher.wake();
    await Promise.resolve();
    const stopping = h.dispatcher.stop();
    release();
    await stopping;
    expect(h.calls.tick).toBe(1);
    expect(h.activeTimers()).toBe(0);
    h.dispatcher.wake();
    await h.advance(3_600_000);
    expect(h.calls.tick).toBe(1);
  });
});
