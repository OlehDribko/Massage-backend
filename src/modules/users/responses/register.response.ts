import type { Response } from "express";
import type { RegisterUserResult } from "../types/user.types.js";
import {
  EMAIL_VERIFICATION_PENDING_CODE,
  EMAIL_VERIFICATION_SENT_CODE,
} from "../email-verification/messages.js";
import { toPublicUser } from "../types/user.public.js";

const registerMessages = {
  createdAndSent: "Account created. Please verify your email to continue.",
  sent:
    "Please check your email to verify your address and complete registration.",
  pending:
    "An account with this email already exists and is awaiting email verification.",
  success: "User created successfully",
} as const;

export const sendRegisterUserResponse = (
  res: Response,
  result: RegisterUserResult,
) => {
  const { user, created, verificationStatus, retryAfterSeconds } = result;
  const data = toPublicUser(user);
  const statusCode = created ? 201 : 200;

  if (verificationStatus === "sent") {
    return res.status(statusCode).json({
      message: created
        ? registerMessages.createdAndSent
        : registerMessages.sent,
      code: EMAIL_VERIFICATION_SENT_CODE,
      data,
    });
  }

  if (verificationStatus === "pending") {
    return res.status(200).json({
      message: registerMessages.pending,
      code: EMAIL_VERIFICATION_PENDING_CODE,
      data,
      ...(retryAfterSeconds !== undefined && retryAfterSeconds > 0
        ? { retryAfterSeconds }
        : {}),
    });
  }

  return res.status(statusCode).json({
    message: registerMessages.success,
    data,
  });
};
