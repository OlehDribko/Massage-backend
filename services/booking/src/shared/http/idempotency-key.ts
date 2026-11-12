import type { Request } from "express";
import { z } from "zod";
import { AppError } from "../errors/app-error.js";

/** Idempotency-Key header of creating requests: 8–128 of [A-Za-z0-9_-] (a UUID fits). */
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

/** The request's Idempotency-Key; missing or malformed is 400 with a fixed code. */
export const idempotencyKeyFrom = (req: Request): string => {
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

/** The same key with a different request body. */
export const idempotencyKeyReused = () =>
  new AppError(422, "This Idempotency-Key was already used for a different request", {
    code: "IDEMPOTENCY_KEY_REUSED",
  });
