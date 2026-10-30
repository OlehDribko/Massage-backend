import type { PrismaClient } from "../generated/prisma/client.js";
import { describeError, type Logger } from "../logging/logger.js";
import type { WorkerTuning } from "./config.js";
import { parseBookingEvent } from "./event-contract.js";
import type { EmailProvider } from "./provider.js";
import { retryDelayMs } from "./retry.js";
import {
  claimDeliveries,
  completeDelivery,
  failExhausted,
  hasNewerEvent,
  planNewEvents,
  type ClaimedDelivery,
  type Completion,
} from "./store.js";
import { renderEmail } from "./templates.js";

export type WorkerDeps = {
  prisma: PrismaClient;
  provider: EmailProvider;
  logger: Logger;
  workerId: string;
  studioEmail: string;
  /** null = no filter (production only). */
  recipientAllowlist: ReadonlySet<string> | null;
  tuning: WorkerTuning;
  now?: () => Date;
  random?: () => number;
};

export type Worker = {
  /** One pass: plan new events, fail exhausted deliveries, process due ones. Returns how many deliveries were handled. */
  tick: () => Promise<number>;
  /** Runs passes until stop(); resolves when the loop has exited. */
  run: () => Promise<void>;
  /** Stops claiming new work; the delivery in flight is finished first. */
  stop: () => Promise<void>;
};

/**
 * Notifications worker (separate process, never started by the HTTP API).
 * The provider call happens outside any database transaction; claiming and
 * recording results are short statements fenced by the lease token.
 */
export const createWorker = (deps: WorkerDeps): Worker => {
  const now = deps.now ?? (() => new Date());
  const { tuning, logger } = deps;
  let stopping = false;
  let pausedUntil = 0;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  const safe = (delivery: ClaimedDelivery) => ({
    deliveryId: delivery.id,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    recipientRole: delivery.recipientRole,
    attempt: delivery.attempts,
  });

  const record = async (delivery: ClaimedDelivery, completion: Completion): Promise<void> => {
    const kept = await completeDelivery(deps.prisma, {
      id: delivery.id,
      leaseToken: delivery.leaseToken,
      now: now(),
      completion,
    });
    const fields = {
      ...safe(delivery),
      status: completion.status,
      code: "resultCode" in completion ? completion.resultCode : (completion.lastErrorCode ?? "released"),
    };
    if (!kept) {
      logger.warn(fields, "notification lease lost; result discarded");
    } else if (completion.status === "failed") {
      logger.error(fields, "notification failed");
    } else {
      logger.info(fields, "notification attempt recorded");
    }
  };

  const process = async (delivery: ClaimedDelivery): Promise<void> => {
    const parsed = parseBookingEvent(delivery);
    if (!parsed.ok) {
      await record(delivery, { status: "failed", resultCode: parsed.reason, lastErrorCode: null });
      return;
    }
    const recipient = delivery.recipientEmail;
    if (recipient === null) {
      await record(delivery, { status: "failed", resultCode: "recipient_missing", lastErrorCode: null });
      return;
    }
    // Agreed rule for stale client emails (2026-10-31): a confirmation or a
    // rescheduling not yet accepted by the provider is skipped when a newer
    // event of the same booking exists (the newer email is complete on its
    // own) or the session has already started. Cancellations and all studio
    // emails are always sent; accepted emails are never touched.
    if (delivery.recipientRole === "client" && parsed.event.type !== "booking.cancelled") {
      if (await hasNewerEvent(deps.prisma, { bookingId: parsed.event.payload.bookingId, position: delivery.eventPosition })) {
        await record(delivery, { status: "skipped", resultCode: "superseded" });
        return;
      }
      if (Date.parse(parsed.event.payload.startsAt) <= now().getTime()) {
        await record(delivery, { status: "skipped", resultCode: "session_already_started" });
        return;
      }
    }
    // Outside production only explicitly allowed test recipients get email;
    // others are skipped visibly, never redirected to another address.
    if (deps.recipientAllowlist !== null && !deps.recipientAllowlist.has(recipient)) {
      await record(delivery, { status: "skipped", resultCode: "recipient_not_allowed" });
      return;
    }

    const email = renderEmail(parsed.event, delivery.recipientRole);
    const outcome = await deps.provider.send({
      to: recipient,
      subject: email.subject,
      html: email.html,
      text: email.text,
      idempotencyKey: delivery.id,
      tags: [delivery.eventType, delivery.recipientRole],
    });

    switch (outcome.kind) {
      case "accepted":
        await record(delivery, { status: "accepted", resultCode: "accepted", providerMessageId: outcome.providerMessageId });
        return;
      case "duplicate":
        await record(delivery, { status: "accepted", resultCode: "accepted_duplicate", providerMessageId: null });
        return;
      case "rejected":
        await record(delivery, { status: "failed", resultCode: outcome.code, lastErrorCode: outcome.code });
        return;
      case "retryable":
        if (delivery.attempts >= tuning.maxAttempts) {
          await record(delivery, { status: "failed", resultCode: "attempts_exhausted", lastErrorCode: outcome.code });
          return;
        }
        await record(delivery, {
          status: "pending",
          nextAttemptAt: new Date(
            now().getTime() + retryDelayMs(delivery.attempts, outcome.retryAfterMs, tuning, deps.random),
          ),
          lastErrorCode: outcome.code,
          refundAttempt: false,
        });
        return;
      case "configuration":
        // Not this message's fault: keep it pending without using up an
        // attempt, and pause the whole worker instead of failing everything.
        pausedUntil = now().getTime() + tuning.configurationPauseMs;
        logger.error({ ...safe(delivery), code: outcome.code, pauseMs: tuning.configurationPauseMs }, "email provider configuration error; worker paused");
        await record(delivery, {
          status: "pending",
          nextAttemptAt: new Date(pausedUntil),
          lastErrorCode: outcome.code,
          refundAttempt: true,
        });
        return;
    }
  };

  const tick = async (): Promise<number> => {
    if (now().getTime() < pausedUntil) {
      return 0;
    }
    const planned = await planNewEvents(deps.prisma, {
      now: now(),
      studioEmail: deps.studioEmail,
      limit: Math.max(50, tuning.batchSize * 5),
    });
    for (const event of planned.filter((item) => item.status === "invalid")) {
      logger.error({ eventId: event.eventId, code: event.reasonCode }, "outbox event cannot be used for notifications");
    }
    const exhausted = await failExhausted(deps.prisma, { now: now(), maxAttempts: tuning.maxAttempts });
    if (exhausted > 0) {
      logger.error({ count: exhausted }, "notifications failed after the last attempt");
    }

    let handled = 0;
    while (!stopping && now().getTime() >= pausedUntil) {
      const batch = await claimDeliveries(deps.prisma, {
        now: now(),
        owner: deps.workerId,
        leaseMs: tuning.leaseMs,
        limit: tuning.batchSize,
        maxAttempts: tuning.maxAttempts,
      });
      if (batch.length === 0) {
        break;
      }
      for (const delivery of batch) {
        if (stopping || now().getTime() < pausedUntil) {
          // Claimed but not started (stop() or a configuration pause): give
          // it back at once, without using up an attempt; nothing was sent.
          await record(delivery, {
            status: "pending",
            nextAttemptAt: new Date(Math.max(now().getTime(), pausedUntil)),
            lastErrorCode: null,
            refundAttempt: true,
          });
          continue;
        }
        await process(delivery);
        handled += 1;
      }
    }
    return handled;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const run = (): Promise<void> => {
    loop ??= (async () => {
      logger.info({ workerId: deps.workerId }, "notifications worker started");
      while (!stopping) {
        try {
          await tick();
        } catch (error) {
          logger.error({ error: describeError(error) }, "notifications worker pass failed");
        }
        if (!stopping) {
          await sleep(tuning.pollIntervalMs);
        }
      }
      logger.info({ workerId: deps.workerId }, "notifications worker stopped");
    })();
    return loop;
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    wake?.();
    await loop;
  };

  return { tick, run, stop };
};
