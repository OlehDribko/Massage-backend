import type { Request, Response, NextFunction } from "express";
import {
  createUserSchema,
  forgotPasswordSchema,
  resendEmailVerificationSchema,
  resetPasswordSchema,
  subscribeToMarketingSchema,
} from "../schema/user.schema.js";

const respondValidationError = (
  res: Response,
  issues: { path: PropertyKey[]; message: string }[],
) => {
  const errorMessages = issues.map((issue) => {
    return { field: issue.path, message: issue.message };
  });

  return res
    .status(400)
    .json({ message: "Validation failed", errors: errorMessages });
};

export const validateCreateUser = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const result = createUserSchema.safeParse(req.body);

  if (!result.success) {
    return respondValidationError(res, result.error.issues);
  }
  req.body = result.data;
  next();
};

export const validateSubscribeToMarketing = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const result = subscribeToMarketingSchema.safeParse(req.body);

  if (!result.success) {
    return respondValidationError(res, result.error.issues);
  }
  req.body = result.data;
  next();
};

export const validateResendEmailVerification = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const result = resendEmailVerificationSchema.safeParse(req.body);

  if (!result.success) {
    return respondValidationError(res, result.error.issues);
  }
  req.body = result.data;
  next();
};

export const validateForgotPassword = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const result = forgotPasswordSchema.safeParse(req.body);

  if (!result.success) {
    return respondValidationError(res, result.error.issues);
  }
  req.body = result.data;
  next();
};

export const validateResetPassword = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const result = resetPasswordSchema.safeParse(req.body);

  if (!result.success) {
    return respondValidationError(res, result.error.issues);
  }
  req.body = result.data;
  next();
};
