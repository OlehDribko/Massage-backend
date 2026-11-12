import { z } from "zod";

/** Largest amount the database column (INTEGER) holds: no business limit. */
export const MAX_AMOUNT_CENTS = 2_147_483_647;

/** Longest description, in characters after trimming. */
export const MAX_DESCRIPTION_LENGTH = 1000;

export const giftCardStatusSchema = z.enum(["new", "in_progress", "completed", "cancelled"]);
export type GiftCardStatus = z.output<typeof giftCardStatusSchema>;

export const contactChannelSchema = z.enum(["email", "phone", "whatsapp"]);
export type ContactChannel = z.output<typeof contactChannelSchema>;

/** Control characters other than line feed, carriage return and tab. */
const hasForbiddenControl = (value: string): boolean =>
  Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return (code < 0x20 && char !== "\n" && char !== "\r" && char !== "\t") || code === 0x7f;
  });

/**
 * Body of POST /api/gift-card-requests. Strict: contacts (email, name,
 * phone) are never accepted from the body; they come from the verified
 * identity and the profile. Currency is set by the server (EUR).
 */
export const createGiftCardRequestSchema = z
  .object({
    // Whole euro cents, > 0, within the stored range; numbers only (no strings).
    amountCents: z
      .int("must be a whole number of cents")
      .positive("must be greater than 0")
      .max(MAX_AMOUNT_CENTS, `must be at most ${String(MAX_AMOUNT_CENTS)}`),
    // Optional; trimmed; empty or only spaces means none.
    description: z
      .string()
      .trim()
      .max(MAX_DESCRIPTION_LENGTH, `must be at most ${String(MAX_DESCRIPTION_LENGTH)} characters`)
      .refine((value) => !hasForbiddenControl(value), "must not contain control characters")
      .nullable()
      .optional()
      .transform((value) => (value === undefined || value === null || value === "" ? null : value)),
    preferredContactChannel: contactChannelSchema,
  })
  .strict();

export type CreateGiftCardRequest = z.output<typeof createGiftCardRequestSchema>;

export const updateGiftCardStatusSchema = z.object({ status: giftCardStatusSchema }).strict();

export const giftCardRequestIdSchema = z.uuid();

/**
 * Allowed admin changes. completed (manual handling finished) and cancelled
 * (closed: mistaken, duplicate, withdrawn) are final; setting the current
 * status again is a no-op, never an error.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<GiftCardStatus, readonly GiftCardStatus[]>> = {
  new: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};
