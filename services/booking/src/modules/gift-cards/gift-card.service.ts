import type {
  GiftCardRequest,
  GiftCardRequestStatusChange,
  Prisma,
  PrismaClient,
  UserProfile,
} from "../../generated/prisma/client.js";
import { postgresErrorCode, prismaErrorCode } from "../../shared/database/errors.js";
import { AppError } from "../../shared/errors/app-error.js";
import { idempotencyKeyReused } from "../../shared/http/idempotency-key.js";
import { bookingReadiness } from "../access/policies.js";
import { normalizePhoneNumber } from "../profiles/phone.js";
import { recordGiftCardRequestCreated } from "./gift-card.events.js";
import { ALLOWED_TRANSITIONS, type CreateGiftCardRequest, type GiftCardStatus } from "./gift-card.schema.js";

export type StatusChangeWithActor = GiftCardRequestStatusChange & {
  changedBy: Pick<UserProfile, "id" | "name" | "email">;
};
export type GiftCardRequestWithHistory = GiftCardRequest & { statusChanges: StatusChangeWithActor[] };

/** Outcome of a write; `changed: false` = repeated request, nothing done. */
export type GiftCardWriteResult = { request: GiftCardRequestWithHistory; changed: boolean };

/**
 * Abuse protection per client, independent of any amount: at most
 * `perWindow` new requests in a rolling `windowMs`. Replays of a request
 * already made do not count. The API Gateway throttling stays as it is.
 */
export type GiftCardLimits = { perWindow: number; windowMs: number };
export const DEFAULT_GIFT_CARD_LIMITS: GiftCardLimits = { perWindow: 5, windowMs: 24 * 60 * 60_000 };

/** Row lock waits at most this long; transaction limits are explicit (Neon may be waking up). */
const LOCK_TIMEOUT_MS = 5_000;

export type GiftCardListQuery = {
  status: GiftCardStatus | undefined;
  createdFrom: Date | undefined;
  createdBefore: Date | undefined;
  page: number;
  pageSize: number;
};

export type GiftCardService = ReturnType<typeof createGiftCardService>;

const requestNotFound = () =>
  new AppError(404, "Gift card request not found", { code: "GIFT_CARD_REQUEST_NOT_FOUND" });

const busy = () =>
  new AppError(503, "Gift card requests are busy; retry shortly", {
    code: "GIFT_CARD_REQUEST_BUSY",
    details: { retryAfterSeconds: 2 },
  });

/** P2002 (Prisma) or 23505 (PostgreSQL): a unique constraint fired. */
const isUniqueViolation = (error: unknown): boolean =>
  prismaErrorCode(error) === "P2002" || postgresErrorCode(error) === "23505";

/**
 * Gift card requests (cartes cadeaux), handled by hand by the studio. A
 * request never takes the masseuse's time: no calendar lock, no schedule
 * rules. Contacts are a snapshot taken at submission from the verified
 * identity (email) and the profile (name, phone); the request body never
 * supplies them.
 */
export const createGiftCardService = ({
  prisma,
  timeZone,
  now,
  limits = DEFAULT_GIFT_CARD_LIMITS,
  afterWrite = () => undefined,
}: {
  prisma: PrismaClient;
  /** Studio time zone, for the email's date and the admin date filter. */
  timeZone: string;
  now: () => Date;
  limits?: GiftCardLimits;
  /** Runs after every create transaction, committed or not (wakes the email sender); must not throw. */
  afterWrite?: () => void;
}) => {
  const withHistory = {
    statusChanges: {
      orderBy: [{ changedAt: "asc" }, { id: "asc" }],
      include: { changedBy: { select: { id: true, name: true, email: true } } },
    },
  } satisfies Prisma.GiftCardRequestInclude;

  const transaction = async <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${String(LOCK_TIMEOUT_MS)}ms`}, true)`;
          return work(tx);
        },
        { maxWait: LOCK_TIMEOUT_MS, timeout: 3 * LOCK_TIMEOUT_MS },
      );
    } catch (error) {
      // 55P03 lock_not_available; P2028: Prisma transaction API timeout.
      if (postgresErrorCode(error) === "55P03" || prismaErrorCode(error) === "P2028") {
        throw busy();
      }
      throw error;
    }
  };

  const findByKey = (db: Prisma.TransactionClient | PrismaClient, clientProfileId: string, idempotencyKey: string) =>
    db.giftCardRequest.findUnique({
      where: { clientProfileId_idempotencyKey: { clientProfileId, idempotencyKey } },
      include: withHistory,
    });

  const replay = (previous: GiftCardRequestWithHistory, fingerprint: string): GiftCardWriteResult => {
    if (previous.requestFingerprint !== fingerprint) {
      throw idempotencyKeyReused();
    }
    return { request: previous, changed: false };
  };

  /** Contacts as of now, re-checked here (the guard checked the same profile). */
  const contactsOf = (client: UserProfile): { name: string; email: string; phone: string } => {
    const readiness = bookingReadiness(client);
    const phone = client.phoneE164 === null ? undefined : normalizePhoneNumber(client.phoneE164);
    if (!readiness.ready || client.name === null || client.email === null || phone === undefined) {
      const blockers: string[] = [...readiness.blockers];
      if (readiness.ready) {
        blockers.push(client.email === null ? "email_not_verified" : "phone_invalid");
      }
      throw new AppError(403, "Profile is not ready for a gift card request", {
        code: "GIFT_CARD_REQUEST_NOT_READY",
        details: { blockers },
      });
    }
    return { name: client.name, email: client.email, phone };
  };

  /**
   * Creates a request with status new, its first history entry and the
   * outbox event for the studio's email, in one transaction. Idempotent per
   * (client, Idempotency-Key): the same key and body return the request it
   * created (changed: false) without a second request or email; the same
   * key with another body is refused (422). Concurrent requests of one
   * client are serialised by a lock on the client's profile row (not a
   * global lock); the unique key is the last line of defence.
   */
  const create = async (
    client: UserProfile,
    body: CreateGiftCardRequest,
    idempotencyKey: string,
  ): Promise<GiftCardWriteResult> => {
    const fingerprint = JSON.stringify([body.amountCents, body.description, body.preferredContactChannel]);
    const previous = await findByKey(prisma, client.id, idempotencyKey);
    if (previous !== null) {
      return replay(previous, fingerprint);
    }
    const contacts = contactsOf(client);

    try {
      return await transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM "UserProfile" WHERE id = ${client.id}::uuid FOR UPDATE`;
        const concurrent = await findByKey(tx, client.id, idempotencyKey);
        if (concurrent !== null) {
          return replay(concurrent, fingerprint);
        }

        const current = now();
        const windowStart = new Date(current.getTime() - limits.windowMs);
        const recent = await tx.giftCardRequest.findMany({
          where: { clientProfileId: client.id, createdAt: { gt: windowStart } },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        });
        const oldest = recent[0];
        if (recent.length >= limits.perWindow && oldest !== undefined) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((oldest.createdAt.getTime() + limits.windowMs - current.getTime()) / 1000),
          );
          throw new AppError(429, "Too many gift card requests; retry later", {
            code: "GIFT_CARD_REQUEST_LIMIT_REACHED",
            details: { retryAfterSeconds },
          });
        }

        const created = await tx.giftCardRequest.create({
          data: {
            clientProfileId: client.id,
            clientName: contacts.name,
            clientEmail: contacts.email,
            clientPhone: contacts.phone,
            amountCents: body.amountCents,
            currency: "EUR",
            description: body.description,
            preferredContactChannel: body.preferredContactChannel,
            status: "new",
            idempotencyKey,
            requestFingerprint: fingerprint,
            createdAt: current,
            statusChanges: {
              create: {
                fromStatus: null,
                toStatus: "new",
                changedByProfileId: client.id,
                changedByRole: client.role,
                changedAt: current,
              },
            },
          },
          include: withHistory,
        });
        await recordGiftCardRequestCreated(tx, created, timeZone);
        return { request: created, changed: true };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await findByKey(prisma, client.id, idempotencyKey);
        if (winner !== null) {
          return replay(winner, fingerprint);
        }
      }
      throw error;
    } finally {
      afterWrite();
    }
  };

  const list = async (query: GiftCardListQuery): Promise<{ total: number; requests: GiftCardRequestWithHistory[] }> => {
    const where: Prisma.GiftCardRequestWhereInput = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.createdFrom === undefined && query.createdBefore === undefined
        ? {}
        : {
            createdAt: {
              ...(query.createdFrom === undefined ? {} : { gte: query.createdFrom }),
              ...(query.createdBefore === undefined ? {} : { lt: query.createdBefore }),
            },
          }),
    };
    const [total, requests] = await prisma.$transaction([
      prisma.giftCardRequest.count({ where }),
      prisma.giftCardRequest.findMany({
        where,
        include: withHistory,
        orderBy: [{ createdAt: "desc" }, { number: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { total, requests };
  };

  const get = async (id: string): Promise<GiftCardRequestWithHistory> => {
    const request = await prisma.giftCardRequest.findUnique({ where: { id }, include: withHistory });
    if (request === null) {
      throw requestNotFound();
    }
    return request;
  };

  /**
   * An admin sets the status. The same status again changes nothing and adds
   * no history entry; a change outside ALLOWED_TRANSITIONS is refused (409).
   * The request row is locked, so concurrent changes apply one after another.
   */
  const updateStatus = (admin: UserProfile, id: string, status: GiftCardStatus): Promise<GiftCardWriteResult> =>
    transaction(async (tx) => {
      const locked = await tx.$queryRaw<unknown[]>`SELECT 1 AS locked FROM "GiftCardRequest" WHERE id = ${id}::uuid FOR UPDATE`;
      const request = locked.length === 0 ? null : await tx.giftCardRequest.findUnique({ where: { id }, include: withHistory });
      if (request === null) {
        throw requestNotFound();
      }
      if (request.status === status) {
        return { request, changed: false };
      }
      const allowed = ALLOWED_TRANSITIONS[request.status];
      if (!allowed.includes(status)) {
        throw new AppError(409, "This status change is not allowed", {
          code: "GIFT_CARD_STATUS_TRANSITION_NOT_ALLOWED",
          details: { from: request.status, to: status, allowed },
        });
      }
      const current = now();
      const updated = await tx.giftCardRequest.update({
        where: { id },
        data: {
          status,
          updatedAt: current,
          statusChanges: {
            create: {
              fromStatus: request.status,
              toStatus: status,
              changedByProfileId: admin.id,
              changedByRole: admin.role,
              changedAt: current,
            },
          },
        },
        include: withHistory,
      });
      return { request: updated, changed: true };
    });

  return { create, list, get, updateStatus, timeZone };
};
