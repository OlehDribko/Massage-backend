import { Router } from "express";
import {
  validateCreateUser,
  validateForgotPassword,
  validateResendEmailVerification,
  validateResetPassword,
  validateSubscribeToMarketing,
} from "./middleware/user.middlewares.js";
import {
  createUser,
  forgotPassword,
  verifyEmail,
  unsubscribeFromMarketing,
  subscribeToMarketing,
  resendEmailVerification,
  resetPassword,
} from "./controller/user.controller.js";
import { validateActionToken } from "../email/middleware/email.middlewares.js";

const router = Router();

router.post("/", validateCreateUser, createUser);

router.post("/subscribe", validateSubscribeToMarketing, subscribeToMarketing);

router.post(
  "/resend-verification",
  validateResendEmailVerification,
  resendEmailVerification,
);

router.post("/forgot-password", validateForgotPassword, forgotPassword);

router.post("/reset-password", validateResetPassword, resetPassword);

router.post("/verify-email", validateActionToken, verifyEmail);

router.post("/unsubscribe", validateActionToken, unsubscribeFromMarketing);

export default router;
