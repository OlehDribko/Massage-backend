import type { Response } from "express";
import type { MarketingSubscriptionResult } from "../types/user.types.js";
import {
  EMAIL_VERIFICATION_PENDING_CODE,
  EMAIL_VERIFICATION_SENT_CODE,
} from "../email-verification/messages.js";

const subscribeMessages = {
  sent: "Check your email to verify your address",
  pending:
    "A verification email was already sent. Please check your inbox and verify your email.",
  success: "User subscribed to marketing successfully",
} as const;

export const sendSubscribeToMarketingResponse = (
  res: Response,
  result: MarketingSubscriptionResult,
) => {
  const { created, verificationStatus, retryAfterSeconds } = result;
  const statusCode = created ? 201 : 200;

  if (verificationStatus === "sent") {
    return res.status(statusCode).json({
      message: subscribeMessages.sent,
      code: EMAIL_VERIFICATION_SENT_CODE,
    });
  }

  if (verificationStatus === "pending") {
    return res.status(statusCode).json({
      message: subscribeMessages.pending,
      code: EMAIL_VERIFICATION_PENDING_CODE,
      ...(retryAfterSeconds !== undefined && retryAfterSeconds > 0
        ? { retryAfterSeconds }
        : {}),
    });
  }

  return res.status(statusCode).json({
    message: subscribeMessages.success,
  });
};
