import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { z } from "zod";
import { AppError } from "../../../shared/errors/app-error.js";

export type ActionTokenPurpose =
  | "marketing_unsubscribe"
  | "email_verify"
  | "password_reset";

const expiryByPurpose: Readonly<
  Record<ActionTokenPurpose, NonNullable<SignOptions["expiresIn"]>>
> = {
  marketing_unsubscribe: "1y",
  email_verify: "7d",
  password_reset: "15m",
};

// Non-strict: standard claims (iat, exp, iss) are allowed alongside these fields.
const actionTokenPayloadSchema = z.object({
  userId: z.string(),
  purpose: z.string(),
});

export type ActionTokenService = {
  createToken(userId: string, purpose: ActionTokenPurpose): string;
  verifyToken(token: string, purpose: ActionTokenPurpose): string;
};

export const createActionTokenService = (secret: string): ActionTokenService => ({
  createToken(userId: string, purpose: ActionTokenPurpose): string {
    return jwt.sign({ userId, purpose }, secret, {
      expiresIn: expiryByPurpose[purpose],
      issuer: "massage-backend",
    });
  },
  verifyToken(token: string, purpose: ActionTokenPurpose): string {
    try {
      // Signature, issuer and expiry are checked by jwt.verify.
      const decoded: unknown = jwt.verify(token, secret, {
        issuer: "massage-backend",
      });
      const payload = actionTokenPayloadSchema.safeParse(decoded);

      if (!payload.success || payload.data.purpose !== purpose) {
        throw new Error("Invalid action token payload");
      }
      return payload.data.userId;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(400, "Invalid action token");
    }
  },
});
