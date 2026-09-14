import type { CreateUserRequest } from "../schema/user.schema.js";
import type { DbUser } from "../types/user.types.js";
import type {
  MarketingSubscriptionResult,
  RegisterUserResult,
  ResendEmailVerificationResult,
  ForgotPasswordResult,
  ResetPasswordResult,
} from "../types/user.types.js";

import { hashPassword } from "../../../shared/security/password.js";
import { userRepository } from "../repository/user.repository.js";
import { AppError } from "../../../shared/errors/app-error.js";
import { UserStatus } from "@prisma/client";
import actionTokenService from "../../email/tokens/action-token.service.js";
import emailService from "../../email/service/email.service.js";
import {
  ensureEmailVerificationSent,
  resolveUnverifiedEmailVerification,
  resendEmailVerificationMail,
  sendSubscriptionConfirmedSafely,
  toVerificationFields,
} from "../email-verification/helpers.js";

const createPendingSubscriber = async (
  email: string,
): Promise<MarketingSubscriptionResult> => {
  const createdUser = await userRepository.createSubscriber({
    email,
    status: UserStatus.subscribed,
    marketingConsent: true,
    emailVerified: false,
  });

  const sendResult = await ensureEmailVerificationSent(createdUser);

  return {
    user: createdUser,
    created: true,
    ...toVerificationFields(sendResult),
  };
};

const createPendingUser = async (
  input: CreateUserRequest,
): Promise<RegisterUserResult> => {
  const passwordHash = await hashPassword(input.password);
  const user = await userRepository.createUser({
    name: input.name,
    email: input.email,
    passwordHash,
    status: UserStatus.registered,
    marketingConsent: input.marketingConsent,
    emailVerified: false,
  });

  const sendResult = await ensureEmailVerificationSent(user);

  return {
    user,
    created: true,
    ...toVerificationFields(sendResult),
  };
};

const upgradeSubscriberToRegistered = async (
  existingUser: DbUser,
  input: CreateUserRequest,
): Promise<RegisterUserResult> => {
  const passwordHash = await hashPassword(input.password);

  const user = await userRepository.upgradeSubscriberToRegistered(
    { id: existingUser.id },
    {
      name: input.name,
      passwordHash,
      status: UserStatus.registered,
      marketingConsent: existingUser.marketingConsent || input.marketingConsent,
    },
  );

  const verification = await resolveUnverifiedEmailVerification(user);

  return {
    user,
    created: false,
    ...verification,
  };
};

const subscribeVerifiedUserToMarketing = async (
  user: DbUser,
): Promise<MarketingSubscriptionResult> => {
  const updatedUser = await userRepository.updateMarketingConsent(
    { id: user.id },
    true,
  );

  await sendSubscriptionConfirmedSafely(updatedUser);

  return {
    user: updatedUser,
    created: false,
    verificationStatus: "not_required",
  };
};

export const registerUser = async (
  input: CreateUserRequest,
): Promise<RegisterUserResult> => {
  const existingUser = await userRepository.findUser({ email: input.email });

  if (!existingUser) {
    return createPendingUser(input);
  }

  if (existingUser.status === UserStatus.registered) {
    if (!existingUser.emailVerified) {
      const verification =
        await resolveUnverifiedEmailVerification(existingUser);

      return {
        user: existingUser,
        created: false,
        ...verification,
      };
    }

    throw new AppError(409, "User with this email already exists");
  }

  return upgradeSubscriberToRegistered(existingUser, input);
};

export const subscribedToMarketingService = async (
  email: string,
): Promise<MarketingSubscriptionResult> => {
  const user = await userRepository.findUser({ email });

  if (!user) {
    return createPendingSubscriber(email);
  }

  if (!user.emailVerified) {
    const verification = await resolveUnverifiedEmailVerification(user);

    return {
      user,
      created: false,
      ...verification,
    };
  }

  if (user.marketingConsent) {
    throw new AppError(409, "User is already subscribed to marketing");
  }

  return subscribeVerifiedUserToMarketing(user);
};

export const resendEmailVerificationService = async (
  email: string,
): Promise<ResendEmailVerificationResult> => {
  const user = await userRepository.findUser({ email });

  const neutralMessage =
    "If an account exists for this email and verification is pending, a message has been sent";

  if (!user || user.emailVerified) {
    return { message: neutralMessage, sent: false };
  }

  const result = await resendEmailVerificationMail(user);

  if (result.reason === "skipped_cooldown") {
    return {
      message: "Please wait before requesting another verification email",
      sent: false,
      ...(result.retryAfterSeconds !== undefined && result.retryAfterSeconds > 0
        ? { retryAfterSeconds: result.retryAfterSeconds }
        : {}),
    };
  }

  return {
    message: "Verification email has been sent",
    sent: true,
  };
};

export const verifyEmailService = async (token: string): Promise<DbUser> => {
  const userId = actionTokenService.verifyToken(token, "email_verify");
  const user = await userRepository.findUser({ id: userId });

  if (!user) {
    throw new AppError(400, "Invalid action token");
  }

  if (user.emailVerified) {
    return user;
  }

  const verifiedUser = await userRepository.markEmailVerified({ id: userId });

  if (verifiedUser.marketingConsent) {
    await sendSubscriptionConfirmedSafely(verifiedUser);
  }

  return verifiedUser;
};

export const unsubscribeFromMarketingService = async (
  token: string,
): Promise<DbUser> => {
  const userId = actionTokenService.verifyToken(token, "marketing_unsubscribe");

  const updatedUser = await userRepository.updateMarketingConsent(
    { id: userId },
    false,
  );

  return updatedUser;
};

const FORGOT_PASSWORD_SENT_MESSAGE =
  "A password reset link has been sent to your email. It is valid for 15 minutes. If your email was not verified yet, confirming the reset will also verify it.";

export const forgotPasswordService = async (
  email: string,
): Promise<ForgotPasswordResult> => {
  const user = await userRepository.findUser({ email });

  if (!user) {
    return {
      message: "No account was found for this email address.",
      code: "ACCOUNT_NOT_FOUND",
      sent: false,
    };
  }

  if (user.status !== UserStatus.registered || !user.passwordHash) {
    return {
      message:
        "This email is not linked to a password account. Register first, or use email verification if your signup is still pending.",
      code: "PASSWORD_RESET_UNAVAILABLE",
      sent: false,
    };
  }

  try {
    await emailService.sendPasswordResetRequest(user);
  } catch (error) {
    console.error("Failed to send password reset email:", error);
    const message =
      error instanceof Error
        ? error.message
        : "Failed to send password reset email";
    throw new AppError(502, message);
  }

  return {
    message: FORGOT_PASSWORD_SENT_MESSAGE,
    code: "PASSWORD_RESET_SENT",
    sent: true,
  };
};

export const resetPasswordService = async (
  token: string,
  password: string,
): Promise<ResetPasswordResult> => {
  const userId = actionTokenService.verifyToken(token, "password_reset");
  const user = await userRepository.findUser({ id: userId });

  if (!user || user.status !== UserStatus.registered || !user.passwordHash) {
    throw new AppError(400, "Invalid or expired password reset token");
  }

  const passwordHash = await hashPassword(password);
  await userRepository.updatePassword({ id: userId }, passwordHash);

  let emailJustVerified = false;

  if (!user.emailVerified) {
    const verifiedUser = await userRepository.markEmailVerified({ id: userId });
    emailJustVerified = true;

    if (verifiedUser.marketingConsent) {
      await sendSubscriptionConfirmedSafely(verifiedUser);
    }
  }

  return {
    message: emailJustVerified
      ? "Password updated successfully. Your email address has also been verified."
      : "Password updated successfully.",
    emailVerified: true,
    emailJustVerified,
  };
};
