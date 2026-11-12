import type { PrismaClient } from "../generated/prisma/client.js";
import type { Logger } from "../logging/logger.js";
import type { WorkerTuning } from "./config.js";
import { bookingPayloadSchema, parseBookingEvent, type BookingEvent } from "./event-contract.js";
import type { EmailProvider } from "./provider.js";
import { retryAfterTooLong, retryDelayMs } from "./retry.js";
import {
  claimDeliveries,
  completeDelivery,
  failExhausted,
  hasNewerEvent,
  lastAcceptedStudioPayload,
  planNewEvents,
  type ClaimedDelivery,
  type Completion,
} from "./store.js";
import { renderEmail, type StudioContext } from "./templates.js";

export type WorkerDeps = {
  prisma: PrismaClient;
  provider: EmailProvider;
  logger: Logger;
  workerId: string;
  studioEmail: string;
  /** EMAIL_FROM_NAME: signature of client emails. */
  senderName: string;
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

  /**
   * What the studio's email about a new or moved booking says: the studio
   * hears only the latest state, compared with what it was last told.
   * - nothing accepted yet (the earlier emails were superseded): a new booking;
   * - accepted before: moved, from the time in that email to the current one;
   * - accepted before with the same time (moved and back): nothing to tell.
   */
  const studioContext = async (event: BookingEvent, position: bigint): Promise<StudioContext> => {
    const told = bookingPayloadSchema.safeParse(
      await lastAcceptedStudioPayload(deps.prisma, { bookingId: event.payload.bookingId, position }),
    );
    if (!told.success) {
      return { kind: "new" };
    }
    if (Date.parse(told.data.startsAt) === Date.parse(event.payload.startsAt)) {
      return { kind: "unchanged" };
    }
    return { kind: "moved", previousStartsAt: told.data.startsAt };
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
    // Stale emails (agreed 2026-10-31, extended to the studio 2026-11-10): an
    // email about the creation or a move, not yet accepted by the provider,
    // is skipped once a newer event of the same booking exists; the newer
    // email is complete on its own. Checked against the outbox, so changes
    // committed before a restart count even if they are not planned yet.
    // Cancellations are always sent; accepted emails are never touched.
    const supersedable = parsed.event.type !== "booking.cancelled";
    const isStale = () =>
      hasNewerEvent(deps.prisma, { bookingId: parsed.event.payload.bookingId, position: delivery.eventPosition });
    if (supersedable && (await isStale())) {
      await record(delivery, { status: "skipped", resultCode: "superseded" });
      return;
    }
    if (delivery.recipientRole === "client" && supersedable && Date.parse(parsed.event.payload.startsAt) <= now().getTime()) {
      await record(delivery, { status: "skipped", resultCode: "session_already_started" });
      return;
    }
    let studio: StudioContext | undefined;
    if (delivery.recipientRole === "studio" && supersedable) {
      studio = await studioContext(parsed.event, delivery.eventPosition);
      if (studio.kind === "unchanged") {
        await record(delivery, { status: "skipped", resultCode: "unchanged" });
        return;
      }
    }
    // Outside production only explicitly allowed test recipients get email;
    // others are skipped visibly, never redirected to another address.
    if (deps.recipientAllowlist !== null && !deps.recipientAllowlist.has(recipient)) {
      await record(delivery, { status: "skipped", resultCode: "recipient_not_allowed" });
      return;
    }

    const email = renderEmail(parsed.event, delivery.recipientRole, {
      senderName: deps.senderName,
      ...(studio === undefined ? {} : { studio }),
    });
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
        // Never earlier than the provider asks; a wait beyond our limit ends
        // automatic processing (agreed 2026-10-31), attempts left or not.
        if (retryAfterTooLong(outcome.retryAfterMs, tuning)) {
          await record(delivery, { status: "failed", resultCode: "retry_after_too_long", lastErrorCode: outcome.code });
          return;
        }
        if (delivery.attempts >= tuning.maxAttempts) {
          await record(delivery, { status: "failed", resultCode: "attempts_exhausted", lastErrorCode: outcome.code });
          return;
        }
        // A newer event arrived while this attempt ran: the old email is not
        // retried, so it neither goes out late nor holds back the newer one.
        if (supersedable && (await isStale())) {
          await record(delivery, { status: "skipped", resultCode: "superseded" });
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
      const batch = await planNewEvents(deps.prisma, {
        now: now(),
        studioEmail: deps.studioEmail,
        limit: tuning.planBatchSize,
        studioDelayMs: tuning.studioDelayMs,
      });
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
