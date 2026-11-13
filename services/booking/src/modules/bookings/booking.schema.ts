import { z } from "zod";

/** An instant with an explicit offset, e.g. "2027-03-29T07:00:00Z" or "2027-03-29T09:00:00+02:00". */
export const instantSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const createBookingSchema = z
  .object({
    serviceId: z.uuid(),
    startsAt: instantSchema,
  })
  .strict();

export type CreateBookingRequest = z.output<typeof createBookingSchema>;

export const rescheduleBookingSchema = z.object({ startsAt: instantSchema }).strict();

export const clientCancelSchema = z.object({}).strict().optional();

export const adminCancelSchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict()
  .optional();

/** Idempotency-Key header of POST /api/bookings (shared with other creating routes). */
export { idempotencyKeySchema } from "../../shared/http/idempotency-key.js";

export const bookingIdSchema = z.uuid();
