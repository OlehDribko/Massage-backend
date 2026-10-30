import type { PrismaClient } from "../generated/prisma/client.js";
import type { Logger } from "../logging/logger.js";
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

export type PassResult = { planned: number; handled: number };

export type Worker = {
  /**
   * One pass over the database: plan all new events, fail exhausted
   * deliveries, send what is due. Waits for nothing in between: retries are
   * left pending with their time, the caller (dispatcher.ts) decides when to
   * run the next pass.
   */
  tick: () => Promise<PassResult>;
  /** Stops claiming new work; the delivery in flight is finished first. */
  stop: () => void;
};

/**
 * Notification sending logic. The provider call happens outside any database
 * transaction and without a dedicated connection; claiming and recording
 * results are short statements fenced by the lease token.
 */
export const createWorker = (deps: WorkerDeps): Worker => {
  const now = deps.now ?? (() => new Date());
  const { tuning, logger } = deps;
  let stopping = false;

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
      case "configuration":
        // A wrong key or account problem is not fixed by retrying in
        // minutes: no automatic retries, visible failed state, logged.
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
    }
  };

  const tick = async (): Promise<PassResult> => {
    // Plan everything that is new, in position order, batch by batch.
    let plannedTotal = 0;
    for (;;) {
      const batch = await planNewEvents(deps.prisma, { now: now(), studioEmail: deps.studioEmail, limit: tuning.planBatchSize });
      plannedTotal += batch.planned.length;
      for (const event of batch.planned.filter((item) => item.status === "invalid")) {
        logger.error({ eventId: event.eventId, code: event.reasonCode }, "outbox event cannot be used for notifications");
      }
      if (stopping || batch.fetched < tuning.planBatchSize) {
        break;
      }
    }

    const exhausted = await failExhausted(deps.prisma, { now: now(), maxAttempts: tuning.maxAttempts });
    if (exhausted > 0) {
      logger.error({ count: exhausted }, "notifications failed after the last attempt");
    }

    let handled = 0;
    while (!stopping) {
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
        if (stopping) {
          // Claimed but not started: give it back at once, without using up
          // an attempt; nothing was sent.
          await record(delivery, { status: "pending", nextAttemptAt: now(), lastErrorCode: null, refundAttempt: true });
          continue;
        }
        await process(delivery);
        handled += 1;
      }
    }
    return { planned: plannedTotal, handled: handled + exhausted };
  };

  const stop = (): void => {
    stopping = true;
  };

  return { tick, stop };
};
