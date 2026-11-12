import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import type { NotificationStatusReader } from "../../notifications/status.js";
import { AppError } from "../../shared/errors/app-error.js";
import { idempotencyKeyFrom } from "../../shared/http/idempotency-key.js";
import { withValidatedBody } from "../../shared/http/validated-body.js";
import { requireActor } from "../access/require-access.js";
import { addDays, localDateSchema, localDateTimeToInstant } from "../schedule/zoned-time.js";
import {
  createGiftCardRequestSchema,
  giftCardRequestIdSchema,
  giftCardStatusSchema,
  updateGiftCardStatusSchema,
} from "./gift-card.schema.js";
import type { GiftCardRequestWithHistory, GiftCardService } from "./gift-card.service.js";
import { toAdminGiftCardView, toClientGiftCardView } from "./gift-card.view.js";

type StatusReader = Pick<NotificationStatusReader, "forGiftCardRequests">;

const statusesOf = async (reader: StatusReader | undefined, requests: GiftCardRequestWithHistory[]) =>
  reader?.forGiftCardRequests(requests.map((request) => request.id));

/**
 * /api/gift-card-requests: a ready client submits a request. Mount behind
 * `authenticate`. There is no client read, edit or delete route (not agreed).
 */
export const createClientGiftCardRouter = ({
  giftCards,
  requireGiftCardClient,
  notificationStatus,
}: {
  giftCards: GiftCardService;
  requireGiftCardClient: RequestHandler;
  /** Absent when emails are off: views then carry `notification: null`. */
  notificationStatus?: StatusReader | undefined;
}): Router => {
  const router = Router();
  router.post(
    "/",
    requireGiftCardClient,
    withValidatedBody(createGiftCardRequestSchema, async (body, res, _next, req) => {
      const idempotencyKey = idempotencyKeyFrom(req);
      const result = await giftCards.create(requireActor(req), body, idempotencyKey);
      const statuses = await statusesOf(notificationStatus, [result.request]);
      if (!result.changed) {
        res.setHeader("Idempotent-Replayed", "true");
      }
      res
        .status(result.changed ? 201 : 200)
        .json({ giftCardRequest: toClientGiftCardView(result.request, statuses?.get(result.request.id)) });
    }),
  );
  return router;
};

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

const positiveInt = (max: number) =>
  z
    .string()
    .regex(/^[1-9][0-9]{0,8}$/, "must be a positive whole number")
    .transform(Number)
    .pipe(z.int().max(max, `must be at most ${String(max)}`));

const listQuerySchema = z
  .object({
    status: giftCardStatusSchema.optional(),
    createdFrom: localDateSchema.optional(),
    createdTo: localDateSchema.optional(),
    page: positiveInt(10_000_000).optional(),
    pageSize: positiveInt(MAX_PAGE_SIZE).optional(),
  })
  .strict()
  .refine((query) => query.createdFrom === undefined || query.createdTo === undefined || query.createdFrom <= query.createdTo, {
    message: "createdFrom must not be after createdTo",
    path: ["createdFrom"],
  });

const validationFailed = (issues: z.ZodError["issues"]) =>
  new AppError(400, "Validation failed", {
    code: "VALIDATION_FAILED",
    details: { errors: issues.map((issue) => ({ field: issue.path.map(String), message: issue.message })) },
  });

const requestIdFrom = (req: Request): string => {
  const parsed = giftCardRequestIdSchema.safeParse(req.params.requestId);
  if (!parsed.success) {
    throw new AppError(404, "Gift card request not found", { code: "GIFT_CARD_REQUEST_NOT_FOUND" });
  }
  return parsed.data;
};

/** /api/admin/gift-card-requests. Mount behind authenticate + requireAdmin. */
export const createAdminGiftCardRouter = ({
  giftCards,
  notificationStatus,
}: {
  giftCards: GiftCardService;
  notificationStatus?: StatusReader | undefined;
}): Router => {
  const router = Router();
  const views = async (requests: GiftCardRequestWithHistory[]) => {
    const statuses = await statusesOf(notificationStatus, requests);
    return requests.map((request) => toAdminGiftCardView(request, statuses?.get(request.id)));
  };

  // Newest first; filters: status, creation date range (local dates of the
  // studio time zone, inclusive); page / pageSize (1–100, default 20).
  router.get("/", async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw validationFailed(parsed.error.issues);
    }
    const query = parsed.data;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const { total, requests } = await giftCards.list({
      status: query.status,
      createdFrom: query.createdFrom === undefined ? undefined : localDateTimeToInstant(query.createdFrom, 0, giftCards.timeZone),
      createdBefore:
        query.createdTo === undefined ? undefined : localDateTimeToInstant(addDays(query.createdTo, 1), 0, giftCards.timeZone),
      page,
      pageSize,
    });
    res.status(200).json({
      timeZone: giftCards.timeZone,
      page,
      pageSize,
      total,
      giftCardRequests: await views(requests),
    });
  });

  router.get("/:requestId", async (req, res) => {
    const [view] = await views([await giftCards.get(requestIdFrom(req))]);
    res.status(200).json({ giftCardRequest: view });
  });

  router.patch(
    "/:requestId/status",
    withValidatedBody(updateGiftCardStatusSchema, async (body, res, _next, req) => {
      const result = await giftCards.updateStatus(requireActor(req), requestIdFrom(req), body.status);
      const [view] = await views([result.request]);
      res.status(200).json({ giftCardRequest: view, changed: result.changed });
    }),
  );

  return router;
};
