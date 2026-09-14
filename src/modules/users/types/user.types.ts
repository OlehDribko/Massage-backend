import type { UserStatus } from "@prisma/client";

export type DbUser = {
  id: string;
  name: string | null;
  email: string;
  passwordHash: string | null;
  status: UserStatus;
  marketingConsent: boolean;
  emailVerified: boolean;
  emailVerificationSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateUserData = {
  name: string;
  email: string;
  passwordHash: string;
  status: UserStatus;
  marketingConsent: boolean;
  emailVerified: boolean;
};

export type CreateSubscriberData = {
  email: string;
  marketingConsent: boolean;
  emailVerified: boolean;
  status: UserStatus;
};

export type UpgradeSubscriberData = {
  name: string;
  passwordHash: string;
  status: UserStatus;
  marketingConsent: boolean;
};

export type VerificationStatus = "sent" | "pending" | "not_required";

export type VerificationResultFields = {
  verificationStatus: VerificationStatus;
  retryAfterSeconds?: number;
};

export type MarketingSubscriptionResult = {
  user: DbUser;
  created: boolean;
} & VerificationResultFields;

export type RegisterUserResult = {
  user: DbUser;
  created: boolean;
} & VerificationResultFields;

export type EmailVerificationSendResult = {
  sent: boolean;
  reason: "sent" | "skipped_cooldown" | "already_verified";
  retryAfterSeconds?: number;
};

export type ResendEmailVerificationResult = {
  message: string;
  sent: boolean;
  retryAfterSeconds?: number;
};

export type ForgotPasswordResult = {
  message: string;
  code:
    | "PASSWORD_RESET_SENT"
    | "ACCOUNT_NOT_FOUND"
    | "PASSWORD_RESET_UNAVAILABLE";
  sent: boolean;
};

export type ResetPasswordResult = {
  message: string;
  emailVerified: boolean;
  emailJustVerified: boolean;
};
