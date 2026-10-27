import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { z } from "zod";
import { AppError } from "../../../shared/errors/app-error.js";

/**
 * Signed links for marketing consent only. Account email verification and
 * password reset belong to Firebase Authentication; no tokens for them exist here.
 */
export type ActionTokenPurpose = "marketing_confirm" | "marketing_unsubscribe";

const expiryByPurpose: Readonly<Record<ActionTokenPurpose, NonNullable<SignOptions["expiresIn"]>>> = {
  marketing_confirm: "7d",
  // Unsubscribe links must keep working for as long as old emails are read.
  marketing_unsubscribe: "1y",
};

const ISSUER = "massage-backend";

// `userId` keeps its historical name so unsubscribe links sent before the
// Firebase migration stay valid; it now holds the MarketingSubscription id
// (the migration reused the legacy ids). Standard claims are allowed.
const actionTokenPayloadSchema = z.object({
  userId: z.string().min(1),
  purpose: z.string(),
  nonce: z.string().optional(),
});

export type ActionTokenClaims = { subjectId: string; nonce: string | undefined };

export type ActionTokenService = {
  createToken(purpose: ActionTokenPurpose, subjectId: string, nonce?: string): string;
  /** Throws 400 INVALID_ACTION_TOKEN for any invalid, expired or foreign token. */
  verifyToken(token: string, purpose: ActionTokenPurpose): ActionTokenClaims;
};

export const invalidActionToken = () =>
  new AppError(400, "Invalid or expired link", { code: "INVALID_ACTION_TOKEN" });

export const createActionTokenService = (secret: string): ActionTokenService => ({
  createToken(purpose, subjectId, nonce) {
    return jwt.sign(
      { userId: subjectId, purpose, ...(nonce !== undefined ? { nonce } : {}) },
      secret,
      { expiresIn: expiryByPurpose[purpose], issuer: ISSUER, algorithm: "HS256" },
    );
  },
  verifyToken(token, purpose) {
    let decoded: unknown;
    try {
      // Signature (HS256 only), issuer and expiry are checked by jwt.verify.
      decoded = jwt.verify(token, secret, { issuer: ISSUER, algorithms: ["HS256"] });
    } catch {
      throw invalidActionToken();
    }

    const payload = actionTokenPayloadSchema.safeParse(decoded);
    if (!payload.success || payload.data.purpose !== purpose) {
      throw invalidActionToken();
    }
    return { subjectId: payload.data.userId, nonce: payload.data.nonce };
  },
});
