import type { DbUser } from "../types/user.types.js";
import type {
  EmailVerificationSendResult,
  VerificationResultFields,
} from "../types/user.types.js";

import { userRepository } from "../repository/user.repository.js";
import { AppError } from "../../../shared/errors/app-error.js";
import emailService from "../../email/service/email.service.js";
import { EMAIL_VERIFICATION_RESEND_COOLDOWN_MS } from "./constants.js";

export const sendSubscriptionConfirmedSafely = async (user: DbUser) => {
  try {
    await emailService.sendOffersSubscriptionConfirmation(user);
  } catch (error) {
    console.error(
      "Failed to send offers subscription confirmation email:",
      error,
    );
  }
};

const sendEmailVerification = async (user: DbUser) => {
  try {
    await emailService.sendEmailVerificationRequest(user);
  } catch (error) {
    console.error("Failed to send email verification request:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to send verification email";
    throw new AppError(502, message);
  }
};

export const getCooldownRetryAfterSeconds = (
  sentAt: Date,
  cooldownMs: number = EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
): number => {
  const elapsedMs = Date.now() - sentAt.getTime();
  return Math.max(0, Math.ceil((cooldownMs - elapsedMs) / 1000));
};

export const buildPendingVerificationMeta = (
  user: DbUser,
): VerificationResultFields => {
  void user;
  return { verificationStatus: "pending" };
};

export const toVerificationFields = (
  result: EmailVerificationSendResult,
): VerificationResultFields => {
  if (result.reason === "sent") {
    return { verificationStatus: "sent" };
  }

  if (result.reason === "already_verified") {
    return { verificationStatus: "not_required" };
  }

  return {
    verificationStatus: "pending",
    ...(result.retryAfterSeconds !== undefined && result.retryAfterSeconds > 0
      ? { retryAfterSeconds: result.retryAfterSeconds }
      : {}),
  };
};

/**
 * First-time / guarded send: claims slot then sends verification email.
 */
export const ensureEmailVerificationSent = async (
  user: DbUser,
  cooldownMs: number = EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
): Promise<EmailVerificationSendResult> => {
  if (user.emailVerified) {
    return { sent: false, reason: "already_verified" };
  }

  const claimedUser = await userRepository.claimEmailVerificationSend(
    user.id,
    cooldownMs,
  );

  if (!claimedUser) {
    const freshUser = await userRepository.findUser({ id: user.id });
    const sentAt = freshUser?.emailVerificationSentAt ?? new Date();

    return {
      sent: false,
      reason: "skipped_cooldown",
      retryAfterSeconds: getCooldownRetryAfterSeconds(sentAt, cooldownMs),
    };
  }

  await sendEmailVerification(claimedUser);
  return { sent: true, reason: "sent" };
};

/**
 * Intentional resend from /resend-verification.
 * Always sends a verification email for an unverified user,
 * even if subscribe/register already triggered one.
 */
export const resendEmailVerificationMail = async (
  user: DbUser,
): Promise<EmailVerificationSendResult> => {
  if (user.emailVerified) {
    return { sent: false, reason: "already_verified" };
  }

  const updatedUser = await userRepository.markEmailVerificationSendAttempt(
    user.id,
  );

  if (!updatedUser) {
    return { sent: false, reason: "already_verified" };
  }

  await sendEmailVerification(updatedUser);
  return { sent: true, reason: "sent" };
};

/**
 * Auto-send only when no verification email was ever sent.
 * Otherwise return pending — intentional resend is /resend-verification only.
 */
export const resolveUnverifiedEmailVerification = async (
  user: DbUser,
): Promise<VerificationResultFields> => {
  if (user.emailVerified) {
    return { verificationStatus: "not_required" };
  }

  if (user.emailVerificationSentAt) {
    return buildPendingVerificationMeta(user);
  }

  const sendResult = await ensureEmailVerificationSent(user);
  return toVerificationFields(sendResult);
};
