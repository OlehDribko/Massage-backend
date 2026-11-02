import { parsePhoneNumberFromString } from "libphonenumber-js/max";

/** Longest accepted input before normalisation (digits, spaces, separators). */
export const MAX_PHONE_INPUT_LENGTH = 32;

const ALLOWED_INPUT = /^\+[0-9 ().-]+$/;

/**
 * Normalises a phone number given in international form ("+33 6 12 34 56 78")
 * to E.164 ("+33612345678"). Returns undefined for anything that is not a
 * valid number for its country (full libphonenumber metadata). National
 * formats without "+" are rejected: no default country is guessed.
 *
 * The number is stored unverified: no SMS, never used for sign-in or recovery.
 */
export const normalizePhoneNumber = (input: string): string | undefined => {
  const text = input.trim();
  if (text.length === 0 || text.length > MAX_PHONE_INPUT_LENGTH || !ALLOWED_INPUT.test(text)) {
    return undefined;
  }

  const parsed = parsePhoneNumberFromString(text);
  if (parsed === undefined || !parsed.isValid()) {
    return undefined;
  }

  return parsed.number;
};
