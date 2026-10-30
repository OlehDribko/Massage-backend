import { Router, type Request } from "express";
import { AppError } from "../../shared/errors/app-error.js";
import { withValidatedBody } from "../../shared/http/validated-body.js";
import type { BookingRules } from "./booking-rules.js";
import { formatLocalTime, scheduleExceptionSchema, weeklyScheduleSchema, type WeeklyInterval } from "./schedule.schema.js";
import type { ScheduleService } from "./schedule.service.js";
import type { MinuteInterval } from "./slots.js";
import { localDateSchema, localDateTimeOf, type LocalDate } from "./zoned-time.js";

const intervalView = (interval: MinuteInterval) => ({
  start: formatLocalTime(interval.startMinute),
  end: formatLocalTime(interval.endMinute),
});

const weeklyView = (intervals: WeeklyInterval[]) =>
  intervals.map((interval) => ({ weekday: interval.weekday, ...intervalView(interval) }));

const exceptionsView = (exceptions: Map<LocalDate, MinuteInterval[]>) =>
  [...exceptions].map(([date, intervals]) => ({
    date,
    closed: intervals.length === 0,
    intervals: intervals.map(intervalView),
  }));

const dateParam = (req: Request): LocalDate => {
  const parsed = localDateSchema.safeParse(req.params.date);
  if (!parsed.success) {
    throw new AppError(400, "Validation failed", {
      code: "VALIDATION_FAILED",
      details: { errors: [{ field: ["date"], message: "must be a calendar date YYYY-MM-DD" }] },
    });
  }
  return parsed.data;
};

const optionalDateQuery = (req: Request, name: "from" | "to"): LocalDate | undefined => {
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

/** Admin: /api/admin/schedule. Mount behind authenticate + requireAdmin. */
export const createAdminScheduleRouter = ({
  schedule,
  rules,
  now,
}: {
  schedule: ScheduleService;
  rules: BookingRules;
  now: () => Date;
}): Router => {
  const router = Router();
  const today = () => localDateTimeOf(now(), rules.timeZone).date;

  const fullView = async () => ({
    timeZone: rules.timeZone,
    weekly: weeklyView(await schedule.getWeekly()),
    exceptions: exceptionsView(await schedule.listExceptions({ from: today() })),
  });

  // Weekly rules and every exception from today on.
  router.get("/", async (_req, res) => {
    res.status(200).json(await fullView());
  });

  router.put(
    "/weekly",
    withValidatedBody(weeklyScheduleSchema, async (intervals, res) => {
      await schedule.setWeekly(intervals);
      res.status(200).json(await fullView());
    }),
  );

  router.get("/exceptions", async (req, res) => {
    const from = optionalDateQuery(req, "from") ?? today();
    const to = optionalDateQuery(req, "to");
    res.status(200).json({
      timeZone: rules.timeZone,
      exceptions: exceptionsView(await schedule.listExceptions(to === undefined ? { from } : { from, to })),
    });
  });

  router.put(
    "/exceptions/:date",
    withValidatedBody(scheduleExceptionSchema, async (intervals, res, _next, req) => {
      const date = dateParam(req);
      await schedule.setException(date, intervals);
      res.status(200).json({ date, closed: intervals.length === 0, intervals: intervals.map(intervalView) });
    }),
  );

  // Back to the weekly rule for that date.
  router.delete("/exceptions/:date", async (req, res) => {
    const date = dateParam(req);
    res.status(200).json({ date, removed: await schedule.removeException(date) });
  });

  return router;
};
