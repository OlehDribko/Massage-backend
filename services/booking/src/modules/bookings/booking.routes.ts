import { Router, type Request, type RequestHandler } from "express";
import type { NotificationStatusReader } from "../../notifications/status.js";
import { AppError } from "../../shared/errors/app-error.js";
import { withValidatedBody } from "../../shared/http/validated-body.js";
import { requireActor } from "../access/require-access.js";
import type { BookingRules } from "../schedule/booking-rules.js";
import { localDateSchema } from "../schedule/zoned-time.js";
import {
  adminCancelSchema,
  bookingIdSchema,
  clientCancelSchema,
  createBookingSchema,
  idempotencyKeySchema,
  rescheduleBookingSchema,
} from "./booking.schema.js";
import type { BookingService } from "./booking.service.js";
import type { BookingWithClient } from "./booking.service.js";
import { toAdminBookingView, toClientBookingView } from "./booking.view.js";

const bookingIdFrom = (req: Request): string => {
  const parsed = bookingIdSchema.safeParse(req.params.bookingId);
  if (!parsed.success) {
    throw new AppError(404, "Booking not found", { code: "BOOKING_NOT_FOUND" });
  }
  return parsed.data;
};

const idempotencyKeyFrom = (req: Request): string => {
  const header = req.get("idempotency-key");
  if (header === undefined || header === "") {
    throw new AppError(400, "Idempotency-Key header is required", { code: "IDEMPOTENCY_KEY_REQUIRED" });
  }
  const parsed = idempotencyKeySchema.safeParse(header);
  if (!parsed.success) {
    throw new AppError(400, "Idempotency-Key must be 8–128 characters of A–Z, a–z, 0–9, _ or -", {
      code: "IDEMPOTENCY_KEY_INVALID",
    });
  }
  return parsed.data;
};

type Guards = {
  /** Any signed-in user; loads the profile. */
  requireProfile: RequestHandler;
  /** A client ready to book (registered, verified email, name, phone). */
  requireBookingClient: RequestHandler;
};

/**
 * /api/bookings: the caller's own bookings. Mount behind `authenticate`.
 * A booking of someone else is always 404, never 403 (no existence oracle).
 */
export const createClientBookingRouter = ({
  bookings,
  guards,
  rules,
  now,
  notificationStatus,
}: {
  bookings: BookingService;
  guards: Guards;
  rules: BookingRules;
  now: () => Date;
  /** Absent when booking emails are off: views then carry `notification: null`. */
  notificationStatus?: NotificationStatusReader | undefined;
}): Router => {
  const router = Router();
  // Statuses are read when the client opens or refreshes a page; no push.
  const views = async (list: BookingWithClient[]) => {
    const statuses = await notificationStatus?.forClient(list.map((booking) => booking.id));
    return list.map((booking) => toClientBookingView(booking, now(), rules, statuses?.get(booking.id) ?? null));
  };
  const view = async (booking: BookingWithClient) => {
    const [result] = await views([booking]);
    if (result === undefined) {
      throw new Error("booking view missing");
    }
    return result;
  };

  router.post(
    "/",
    guards.requireBookingClient,
    withValidatedBody(createBookingSchema, async (body, res, _next, req) => {
      const idempotencyKey = idempotencyKeyFrom(req);
      const result = await bookings.create(requireActor(req), body, idempotencyKey);
      if (!result.changed) {
        res.setHeader("Idempotent-Replayed", "true");
      }
      res.status(result.changed ? 201 : 200).json({ booking: await view(result.booking) });
    }),
  );

  router.get("/", guards.requireProfile, async (req, res) => {
    const own = await bookings.listOwn(requireActor(req));
    res.status(200).json({ bookings: await views(own) });
  });

  router.get("/:bookingId", guards.requireProfile, async (req, res) => {
    res.status(200).json({ booking: await view(await bookings.getOwn(requireActor(req), bookingIdFrom(req))) });
  });

  router.post(
    "/:bookingId/reschedule",
    guards.requireBookingClient,
    withValidatedBody(rescheduleBookingSchema, async (body, res, _next, req) => {
      const result = await bookings.reschedule(requireActor(req), bookingIdFrom(req), body.startsAt);
      res.status(200).json({ booking: await view(result.booking), changed: result.changed });
    }),
  );

  router.post(
    "/:bookingId/cancel",
    guards.requireProfile,
    withValidatedBody(clientCancelSchema, async (_body, res, _next, req) => {
      const result = await bookings.cancelOwn(requireActor(req), bookingIdFrom(req));
      res.status(200).json({ booking: await view(result.booking), changed: result.changed });
    }),
  );

  return router;
};

/** /api/admin/bookings: minimal view for cancelling. Mount behind authenticate + requireAdmin. */
export const createAdminBookingRouter = ({
  bookings,
  rules,
  now,
  notificationStatus,
}: {
  bookings: BookingService;
  rules: BookingRules;
  now: () => Date;
  notificationStatus?: NotificationStatusReader | undefined;
}): Router => {
  const router = Router();
  const views = async (list: BookingWithClient[]) => {
    const statuses = await notificationStatus?.forAdmin(list.map((booking) => booking.id));
    return list.map((booking) => toAdminBookingView(booking, now(), rules, statuses?.get(booking.id) ?? []));
  };
  const view = async (booking: BookingWithClient) => {
    const [result] = await views([booking]);
    if (result === undefined) {
      throw new Error("booking view missing");
    }
    return result;
  };

  // Bookings starting on a local date (studio time zone), all statuses.
  router.get("/", async (req, res) => {
    const parsed = localDateSchema.safeParse(req.query.date);
    if (!parsed.success) {
      throw new AppError(400, "Validation failed", {
        code: "VALIDATION_FAILED",
        details: { errors: [{ field: ["date"], message: "query parameter date=YYYY-MM-DD is required" }] },
      });
    }
    const list = await bookings.listForDate(parsed.data);
    res.status(200).json({ date: parsed.data, timeZone: rules.timeZone, bookings: await views(list) });
  });

  router.get("/:bookingId", async (req, res) => {
    res.status(200).json({ booking: await view(await bookings.getAny(bookingIdFrom(req))) });
  });

  router.post(
    "/:bookingId/cancel",
    withValidatedBody(adminCancelSchema, async (body, res, _next, req) => {
      const result = await bookings.cancelByAdmin(requireActor(req), bookingIdFrom(req), body?.reason ?? null);
      res.status(200).json({ booking: await view(result.booking), changed: result.changed });
    }),
  );

  return router;
};
