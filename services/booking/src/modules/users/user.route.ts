import { Router } from "express";
import {
  createUserSchema,
  forgotPasswordSchema,
  resendEmailVerificationSchema,
  resetPasswordSchema,
  subscribeToMarketingSchema,
} from "./schema/user.schema.js";
import type { UserControllers } from "./controller/user.controller.js";
import { actionTokenSchema } from "../email/schema/email.schema.js";
import { withValidatedBody } from "../../shared/http/validated-body.js";

export const createUserRouter = ({
  createUser,
  forgotPassword,
  verifyEmail,
  unsubscribeFromMarketing,
  subscribeToMarketing,
  resendEmailVerification,
  resetPassword,
}: UserControllers): Router => {
  const router = Router();

  router.post("/", withValidatedBody(createUserSchema, createUser));

  router.post(
    "/subscribe",
    withValidatedBody(subscribeToMarketingSchema, subscribeToMarketing),
  );

  router.post(
    "/resend-verification",
    withValidatedBody(resendEmailVerificationSchema, resendEmailVerification),
  );

  router.post(
    "/forgot-password",
    withValidatedBody(forgotPasswordSchema, forgotPassword),
  );

  router.post(
    "/reset-password",
    withValidatedBody(resetPasswordSchema, resetPassword),
  );

  router.post("/verify-email", withValidatedBody(actionTokenSchema, verifyEmail));

  router.post(
    "/unsubscribe",
    withValidatedBody(actionTokenSchema, unsubscribeFromMarketing),
  );

  return router;
};
