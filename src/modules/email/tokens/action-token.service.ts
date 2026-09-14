import jwt from "jsonwebtoken";
import { AppError } from "../../../shared/errors/app-error.js";

const secret = process.env.ACTION_TOKEN_SECRET;

if (!secret) {
  throw new Error("ACTION_TOKEN_SECRET is not set");
}

export type ActionTokenPurpose =
  | "marketing_unsubscribe"
  | "email_verify"
  | "password_reset";

const expiryByPurpose = {
  marketing_unsubscribe: "1y",
  email_verify: "7d",
  password_reset: "15m",
} as const;

const actionTokenService = {
  createToken(userId: string, purpose: ActionTokenPurpose): string {
    return jwt.sign({ userId, purpose }, secret, {
      expiresIn: expiryByPurpose[purpose],
      issuer: "massage-backend",
    });
  },
  verifyToken(token: string, purpose: ActionTokenPurpose): string {
    try {
      const decoded = jwt.verify(token, secret, { issuer: "massage-backend" });
      if (typeof decoded === "string") {
        throw new Error("Invalid action token payload");
      }

      if (decoded.purpose !== purpose || typeof decoded.userId !== "string") {
        throw new Error("Invalid action token payload");
      }
      return decoded.userId;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(400, "Invalid action token");
    }
  },
};

export default actionTokenService;
