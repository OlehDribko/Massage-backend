import { z } from "zod";
import { normalizePhoneNumber } from "./phone.js";

// Letters, marks, spaces and common name punctuation; no control or
// formatting characters (they could hide text in emails or the admin UI).
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;

export const MAX_NAME_LENGTH = 80;

const nameSchema = z
  .string()
  .trim()
  .min(1, "must not be empty")
  .max(MAX_NAME_LENGTH, `must be at most ${MAX_NAME_LENGTH} characters`)
  .regex(NAME_PATTERN, "may contain letters, spaces, apostrophes, dots and hyphens only");

const phoneSchema = z
  .string()
  .transform((value, ctx) => {
    const normalized = normalizePhoneNumber(value);
    if (normalized === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "must be a valid phone number in international format, e.g. +33612345678",
      });
      return z.NEVER;
    }
    return normalized;
  });

/**
 * Fields a user may change on their own profile. Strict: email, role,
 * emailVerified, ids and anything else are rejected, never ignored.
 * Email changes go through Firebase (verifyBeforeUpdateEmail) and reach the
 * profile with the next sync. `null` clears a field.
 */
export const updateOwnProfileSchema = z
  .object({
    name: nameSchema.nullable().optional(),
    phone: phoneSchema.nullable().optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.phone !== undefined, {
    message: "at least one of name, phone is required",
  });

export type UpdateOwnProfileRequest = z.output<typeof updateOwnProfileSchema>;

/** Provider display name as a default for new profiles, or null if unusable. */
export const defaultNameFrom = (providerName: string | undefined): string | null => {
  if (providerName === undefined) {
    return null;
  }
  const parsed = nameSchema.safeParse(providerName);
  return parsed.success ? parsed.data : null;
};
