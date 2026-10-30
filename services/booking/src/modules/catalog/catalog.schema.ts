import { z } from "zod";

/** Integer euro cents; 0 allowed (free service), up to 100 000 €. */
export const priceCentsSchema = z.int().min(0).max(10_000_000);

/** Positive whole minutes, 5 min … 8 h. */
export const durationMinutesSchema = z.int().min(5).max(480);

const nameSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z.string().trim().min(1).max(2000);

export const createServiceSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.nullable().optional(),
    durationMinutes: durationMinutesSchema,
    priceCents: priceCentsSchema,
  })
  .strict();

export type CreateServiceRequest = z.output<typeof createServiceSchema>;

export const updateServiceSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    durationMinutes: durationMinutesSchema.optional(),
    priceCents: priceCentsSchema.optional(),
    /** false = archive (no new bookings), true = bookable again. */
    bookable: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "at least one field is required" });

export type UpdateServiceRequest = z.output<typeof updateServiceSchema>;

export const serviceIdSchema = z.uuid();
