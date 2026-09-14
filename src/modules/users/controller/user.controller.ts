import type { Request, Response } from "express";
import type { NextFunction } from "express";
import type { CreateUserRequest } from "../schema/user.schema.js";
import type { SubscribeToMarketingRequest } from "../schema/user.schema.js";
import type { ResendEmailVerificationRequest } from "../schema/user.schema.js";
import type { ForgotPasswordRequest } from "../schema/user.schema.js";
import type { ResetPasswordRequest } from "../schema/user.schema.js";
import type { ActionTokenRequest } from "../../email/schema/email.schema.js";

import { registerUser } from "../service/user.service.js";
import { subscribedToMarketingService } from "../service/user.service.js";
import { resendEmailVerificationService } from "../service/user.service.js";
import { verifyEmailService } from "../service/user.service.js";
import { unsubscribeFromMarketingService } from "../service/user.service.js";
import { forgotPasswordService } from "../service/user.service.js";
import { resetPasswordService } from "../service/user.service.js";
import { sendRegisterUserResponse } from "../responses/register.response.js";
import { sendSubscribeToMarketingResponse } from "../responses/subscribe.response.js";
import { sendForgotPasswordResponse } from "../responses/forgot-password.response.js";

export const createUser = async (
  req: Request<{}, {}, CreateUserRequest>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await registerUser(req.body);
    return sendRegisterUserResponse(res, result);
  } catch (error) {
    next(error);
  }
};

export const subscribeToMarketing = async (
  req: Request<{}, {}, SubscribeToMarketingRequest>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await subscribedToMarketingService(req.body.email);
    return sendSubscribeToMarketingResponse(res, result);
  } catch (error) {
    next(error);
  }
};

export const resendEmailVerification = async (
  req: Request<{}, {}, ResendEmailVerificationRequest>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await resendEmailVerificationService(req.body.email);

    if (result.retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
    }

    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

export const forgotPassword = async (
  req: Request<{}, {}, ForgotPasswordRequest>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await forgotPasswordService(req.body.email);
    return sendForgotPasswordResponse(res, result);
  } catch (error) {
    next(error);
  }
};

export const resetPassword = async (
  req: Request<{}, {}, ResetPasswordRequest>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { token, password } = req.body;
    const result = await resetPasswordService(token, password);
    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

export const verifyEmail = async (
  req: Request<{}, {}, ActionTokenRequest>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await verifyEmailService(req.body.token);
    return res.status(200).json({ message: "Email verified successfully" });
  } catch (error) {
    next(error);
  }
};

export const unsubscribeFromMarketing = async (
  req: Request<{}, {}, ActionTokenRequest>,
  res: Response,
  next: NextFunction,
) => {
  try {
    await unsubscribeFromMarketingService(req.body.token);
    return res
      .status(200)
      .json({ message: "User unsubscribed from marketing successfully" });
  } catch (error) {
    next(error);
  }
};
