import { createHash } from "node:crypto";

/**
 * Deterministic idempotency key for Brevo (`headers.idempotencyKey`, a UUID):
 * the same parts always give the same key, so a repeat of the same operation
 * is recognised by Brevo within its window, while a different operation (for
 * example a new confirmation with a new nonce) gets a different key.
 * SHA-256 of the parts, formatted as a UUID (version 8: custom).
 */
export const idempotencyKeyFor = (...parts: string[]): string => {
  const hex = createHash("sha256").update(parts.map((part) => `${String(part.length)}:${part}`).join("|")).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
