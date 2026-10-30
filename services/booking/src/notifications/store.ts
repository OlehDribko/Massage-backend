import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { parseBookingEvent } from "./event-contract.js";

/**
 * Persistence of the notifications worker. It reads OutboxEvent (the agreed
 * integration point) and writes only NotificationEvent and
 * NotificationDelivery; it never creates or changes outbox events and never
 * touches catalogue, profile or booking tables.
 */

const recipientEmailSchema = z.email();

export type PlannedEvent = { eventId: string; status: "planned" | "invalid"; reasonCode: string | null };

/**
 * Records deliveries for outbox events not yet examined, in position order.
 * Each event is planned once (primary key on eventId): its recipients are
 * fixed then, so a later change of the studio address never adds deliveries
 * for an event already planned. Unusable events get a visible invalid state.
 */
export const planNewEvents = async (
  prisma: PrismaClient,
  { now, studioEmail, limit }: { now: Date; studioEmail: string; limit: number },
): Promise<PlannedEvent[]> => {
  const events = await prisma.outboxEvent.findMany({
    where: { notification: { is: null } },
    orderBy: { position: "asc" },
    take: limit,
  });

  const planned: PlannedEvent[] = [];
  for (const row of events) {
    const parsed = parseBookingEvent(row);
    const result = await prisma.$transaction(async (tx): Promise<PlannedEvent | null> => {
      const inserted = await tx.notificationEvent.createMany({
        data: [
          {
            eventId: row.id,
            position: row.position,
            status: parsed.ok ? "planned" : "invalid",
            reasonCode: parsed.ok ? null : parsed.reason,
            processedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        return null; // planned concurrently by another worker
      }
      if (!parsed.ok) {
        return { eventId: row.id, status: "invalid", reasonCode: parsed.reason };
      }

      const common = {
        eventId: row.id,
        eventPosition: row.position,
        eventType: parsed.event.type,
        bookingId: parsed.event.payload.bookingId,
        nextAttemptAt: now,
      };
      const clientEmail = parsed.event.payload.client.email;
      const clientEmailValid = clientEmail !== null && recipientEmailSchema.safeParse(clientEmail).success;
      await tx.notificationDelivery.createMany({
        data: [
          clientEmailValid
            ? { ...common, recipientRole: "client", recipientEmail: clientEmail.toLowerCase() }
            : {
                ...common,
                recipientRole: "client",
                recipientEmail: null,
                status: "failed",
                resultCode: clientEmail === null ? "recipient_missing" : "recipient_invalid",
                completedAt: now,
              },
          { ...common, recipientRole: "studio", recipientEmail: studioEmail },
        ],
        skipDuplicates: true,
      });
      return { eventId: row.id, status: "planned", reasonCode: null };
    });
    if (result !== null) {
      planned.push(result);
    }
  }
  return planned;
};

const claimedRowSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  eventPosition: z.bigint(),
  eventType: z.string(),
  recipientRole: z.enum(["client", "studio"]),
  recipientEmail: z.string().nullable(),
  attempts: z.number().int(),
  leaseToken: z.uuid(),
  type: z.string(),
  schemaVersion: z.number().int(),
  aggregateType: z.string(),
  aggregateId: z.uuid(),
  payload: z.unknown(),
});

export type ClaimedDelivery = z.output<typeof claimedRowSchema>;

/**
 * Leases up to `limit` deliveries that are due, in one short transaction.
 * - due: pending with nextAttemptAt reached, or in_progress with an expired
 *   lease (its worker died or hung);
 * - order: only the earliest unfinished delivery of each (booking,
 *   recipient) chain is eligible, so one recipient's emails for one booking
 *   go out in event order, retries included; the client's and the studio's
 *   chains are independent;
 * - FOR UPDATE SKIP LOCKED: concurrent workers never take the same row;
 * - a fresh leaseToken per claim fences out a worker whose lease expired.
 */
export const claimDeliveries = async (
  prisma: PrismaClient,
  { now, owner, leaseMs, limit, maxAttempts }: { now: Date; owner: string; leaseMs: number; limit: number; maxAttempts: number },
): Promise<ClaimedDelivery[]> => {
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const rows = await prisma.$queryRaw<unknown[]>`
    WITH due AS (
      SELECT d.id
      FROM "NotificationDelivery" d
      WHERE ((d.status = 'pending' AND d."nextAttemptAt" <= ${now})
          OR (d.status = 'in_progress' AND d."leaseExpiresAt" <= ${now}))
        AND d.attempts < ${maxAttempts}
        AND NOT EXISTS (
          SELECT 1 FROM "NotificationDelivery" e
          WHERE e."bookingId" = d."bookingId"
            AND e."recipientRole" = d."recipientRole"
            AND e."eventPosition" < d."eventPosition"
            AND e.status IN ('pending', 'in_progress')
        )
      ORDER BY d."eventPosition", d."recipientRole"
      LIMIT ${limit}
      FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE "NotificationDelivery" d
    SET status = 'in_progress',
        "leaseOwner" = ${owner},
        "leaseToken" = gen_random_uuid(),
        "leaseExpiresAt" = ${leaseExpiresAt},
        attempts = d.attempts + 1,
        "updatedAt" = ${now}
    FROM due, "OutboxEvent" o
    WHERE d.id = due.id AND o.id = d."eventId"
    RETURNING d.id, d."eventId", d."eventPosition", d."eventType", d."recipientRole"::text AS "recipientRole", d."recipientEmail",
              d.attempts, d."leaseToken", o.type, o."schemaVersion", o."aggregateType", o."aggregateId", o.payload`;
  return z.array(claimedRowSchema).parse(rows);
};

/**
 * Deliveries whose attempts are used up while no worker holds them (e.g. a
 * worker died after its last claim): terminal failed, visible.
 */
export const failExhausted = async (
  prisma: PrismaClient,
  { now, maxAttempts }: { now: Date; maxAttempts: number },
): Promise<number> => {
  const result = await prisma.$executeRaw`
    UPDATE "NotificationDelivery"
    SET status = 'failed', "resultCode" = 'attempts_exhausted', "completedAt" = ${now},
        "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = ${now}
    WHERE attempts >= ${maxAttempts}
      AND ((status = 'pending' AND "nextAttemptAt" <= ${now})
        OR (status = 'in_progress' AND "leaseExpiresAt" <= ${now}))`;
  return result;
};

export type Completion =
  | { status: "accepted"; resultCode: "accepted" | "accepted_duplicate"; providerMessageId: string | null }
  | { status: "failed"; resultCode: string; lastErrorCode: string | null }
  | { status: "skipped"; resultCode: string }
  | { status: "pending"; nextAttemptAt: Date; lastErrorCode: string | null; refundAttempt: boolean };

/**
 * Records the result of an attempt, only if this worker still holds the
 * lease (same leaseToken, still in_progress). false = the lease was lost
 * (expired and re-claimed): the result is discarded, the newer worker's
 * outcome stands.
 */
export const completeDelivery = async (
  prisma: PrismaClient,
  { id, leaseToken, now, completion }: { id: string; leaseToken: string; now: Date; completion: Completion },
): Promise<boolean> => {
  const releaseLease = { leaseOwner: null, leaseToken: null, leaseExpiresAt: null, updatedAt: now };
  let data: Prisma.NotificationDeliveryUpdateManyMutationInput;
  switch (completion.status) {
    case "accepted":
      data = {
        ...releaseLease,
        status: "accepted",
        resultCode: completion.resultCode,
        providerMessageId: completion.providerMessageId,
        acceptedAt: now,
        completedAt: now,
      };
      break;
    case "failed":
      data = {
        ...releaseLease,
        status: "failed",
        resultCode: completion.resultCode,
        lastErrorCode: completion.lastErrorCode,
        completedAt: now,
      };
      break;
    case "skipped":
      data = { ...releaseLease, status: "skipped", resultCode: completion.resultCode, completedAt: now };
      break;
    case "pending":
      data = {
        ...releaseLease,
        status: "pending",
        nextAttemptAt: completion.nextAttemptAt,
        lastErrorCode: completion.lastErrorCode,
        ...(completion.refundAttempt ? { attempts: { decrement: 1 } } : {}),
      };
      break;
  }
  const result = await prisma.notificationDelivery.updateMany({
    where: { id, leaseToken, status: "in_progress" },
    data,
  });
  return result.count === 1;
};

export const newWorkerId = (): string => `worker-${randomUUID()}`;

/** Whether the outbox already holds a later event of the same booking. */
export const hasNewerEvent = async (
  prisma: PrismaClient,
  { bookingId, position }: { bookingId: string; position: bigint },
): Promise<boolean> => (await prisma.outboxEvent.count({ where: { aggregateId: bookingId, position: { gt: position } } })) > 0;
