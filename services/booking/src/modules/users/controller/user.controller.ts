import type { Response } from "express";
import type { NextFunction } from "express";
import type { CreateUserRequest } from "../schema/user.schema.js";
import type { SubscribeToMarketingRequest } from "../schema/user.schema.js";
import type { ResendEmailVerificationRequest } from "../schema/user.schema.js";
import type { ForgotPasswordRequest } from "../schema/user.schema.js";
import type { ResetPasswordRequest } from "../schema/user.schema.js";
import type { ActionTokenRequest } from "../../email/schema/email.schema.js";

import type { UserService } from "../service/user.service.js";
import { sendRegisterUserResponse } from "../responses/register.response.js";
import { sendSubscribeToMarketingResponse } from "../responses/subscribe.response.js";
import { sendForgotPasswordResponse } from "../responses/forgot-password.response.js";

// Controllers receive bodies already parsed by withValidatedBody (see user.route.ts).
export type UserControllers = ReturnType<typeof createUserControllers>;

export const createUserControllers = (userService: UserService) => {
  const createUser = async (
    body: CreateUserRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const result = await userService.registerUser(body);
      return sendRegisterUserResponse(res, result);
    } catch (error) {
      next(error);
    }
  };

  const subscribeToMarketing = async (
    body: SubscribeToMarketingRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const result = await userService.subscribedToMarketingService(body.email);
      return sendSubscribeToMarketingResponse(res, result);
    } catch (error) {
      next(error);
    }
  };

  const resendEmailVerification = async (
    body: ResendEmailVerificationRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const result = await userService.resendEmailVerificationService(body.email);

      if (result.retryAfterSeconds !== undefined) {
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
      }

      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };

  const forgotPassword = async (
    body: ForgotPasswordRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const result = await userService.forgotPasswordService(body.email);
      return sendForgotPasswordResponse(res, result);
    } catch (error) {
      next(error);
    }
  };

  const resetPassword = async (
    body: ResetPasswordRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      const { token, password } = body;
      const result = await userService.resetPasswordService(token, password);
      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };

  const verifyEmail = async (
    body: ActionTokenRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      await userService.verifyEmailService(body.token);
      return res.status(200).json({ message: "Email verified successfully" });
    } catch (error) {
      next(error);
    }
  };

  const unsubscribeFromMarketing = async (
    body: ActionTokenRequest,
    res: Response,
    next: NextFunction,
  ) => {
    try {
      await userService.unsubscribeFromMarketingService(body.token);
      return res
        .status(200)
        .json({ message: "User unsubscribed from marketing successfully" });
    } catch (error) {
      next(error);
    }
  };

  return {
    createUser,
    subscribeToMarketing,
    resendEmailVerification,
    forgotPassword,
    resetPassword,
    verifyEmail,
    unsubscribeFromMarketing,
  };
};
