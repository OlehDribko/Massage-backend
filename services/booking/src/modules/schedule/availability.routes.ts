import { Router, type Request } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../shared/errors/app-error.js";
import { serviceIdFrom } from "../catalog/catalog.routes.js";
import type { CatalogService } from "../catalog/catalog.service.js";
import { availableDays } from "./availability.js";
import type { BookingRules } from "./booking-rules.js";
import { daysBetween, localDateSchema, type LocalDate } from "./zoned-time.js";

const dateQuery = (req: Request, name: "from" | "to"): LocalDate | undefined => {
  const value = req.query[name];
  if (value === undefined) {
    return undefined;
  }
  const parsed = localDateSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, "Validation failed", {
      code: "VALIDATION_FAILED",
      details: { errors: [{ field: [name], message: "must be a calendar date YYYY-MM-DD" }] },
    });
  }
  return parsed.data;
};

/**
 * Public: GET /api/services/:serviceId/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Free starts of a bookable service, per local date of the studio, within
 * [today, today + horizon]. Contains times only: nothing about who booked.
 */
export const createPublicAvailabilityRouter = ({
  prisma,
  catalog,
  rules,
  now,
}: {
  prisma: PrismaClient;
  catalog: CatalogService;
  rules: BookingRules;
  now: () => Date;
}): Router => {
  const router = Router({ mergeParams: true });

  router.get("/", async (req, res) => {
    const service = await catalog.getBookable(serviceIdFrom(req));
    const from = dateQuery(req, "from");
    const to = dateQuery(req, "to");
    if (from !== undefined && to !== undefined && daysBetween(from, to) < 0) {
      throw new AppError(400, "Validation failed", {
        code: "VALIDATION_FAILED",
        details: { errors: [{ field: ["to"], message: "must not be before from" }] },
      });
    }
    const availability = await availableDays(prisma, {
      durationMinutes: service.durationMinutes,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      now: now(),
      rules,
    });
    res.status(200).json({
      serviceId: service.id,
      durationMinutes: service.durationMinutes,
      timeZone: rules.timeZone,
      from: availability.from,
      to: availability.to,
      days: availability.days.map((day) => ({
        date: day.date,
        slots: day.slots.map((slot) => ({ startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString() })),
      })),
    });
  });

  return router;
};
