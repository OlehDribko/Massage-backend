import { prisma } from "../../../shared/database/prisma.js";

import type { Prisma } from "@prisma/client";
import type { CreateSubscriberData } from "../types/user.types.js";
import type { CreateUserData } from "../types/user.types.js";
import type { DbUser } from "../types/user.types.js";
import type { UpgradeSubscriberData } from "../types/user.types.js";
import { EMAIL_VERIFICATION_RESEND_COOLDOWN_MS } from "../email-verification/constants.js";

export const userRepository = {
  createUser: async (userData: CreateUserData): Promise<DbUser> => {
    return prisma.user.create({ data: userData }) as Promise<DbUser>;
  },

  findUser: async (
    where: Prisma.UserWhereUniqueInput,
  ): Promise<DbUser | null> => {
    return prisma.user.findUnique({ where }) as Promise<DbUser | null>;
  },
  updateMarketingConsent: async (
    where: Prisma.UserWhereUniqueInput,
    marketingConsent: boolean,
  ): Promise<DbUser> => {
    return prisma.user.update({
      where,
      data: { marketingConsent },
    }) as Promise<DbUser>;
  },
  markEmailVerified: async (
    where: Prisma.UserWhereUniqueInput,
  ): Promise<DbUser> => {
    return prisma.user.update({
      where,
      data: { emailVerified: true },
    }) as Promise<DbUser>;
  },

  claimEmailVerificationSend: async (
    userId: string,
    cooldownMs: number = EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  ): Promise<DbUser | null> => {
    const cooldownSince = new Date(Date.now() - cooldownMs);
    const args = {
      where: {
        id: userId,
        emailVerified: false,
        OR: [
          { emailVerificationSentAt: null },
          { emailVerificationSentAt: { lt: cooldownSince } },
        ],
      },
      data: { emailVerificationSentAt: new Date() },
    } as unknown as Prisma.UserUpdateManyArgs;

    const result = await prisma.user.updateMany(args);

    if (result.count === 0) {
      return null;
    }

    return prisma.user.findUnique({
      where: { id: userId },
    }) as Promise<DbUser | null>;
  },

  markEmailVerificationSendAttempt: async (
    userId: string,
  ): Promise<DbUser | null> => {
    const args = {
      where: {
        id: userId,
        emailVerified: false,
      },
      data: { emailVerificationSentAt: new Date() },
    } as unknown as Prisma.UserUpdateManyArgs;

    const result = await prisma.user.updateMany(args);

    if (result.count === 0) {
      return null;
    }

    return prisma.user.findUnique({
      where: { id: userId },
    }) as Promise<DbUser | null>;
  },
  getAllUsers: async (): Promise<Omit<DbUser, "passwordHash">[]> => {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        marketingConsent: true,
        emailVerified: true,
        emailVerificationSentAt: true,
        createdAt: true,
        updatedAt: true,
      },
    } as unknown as Prisma.UserFindManyArgs);

    return users as unknown as Omit<DbUser, "passwordHash">[];
  },
  createSubscriber: async (data: CreateSubscriberData): Promise<DbUser> => {
    return prisma.user.create({ data }) as Promise<DbUser>;
  },
  upgradeSubscriberToRegistered: async (
    where: Prisma.UserWhereUniqueInput,
    data: UpgradeSubscriberData,
  ): Promise<DbUser> => {
    return prisma.user.update({
      where,
      data,
    }) as Promise<DbUser>;
  },
  updatePassword: async (
    where: Prisma.UserWhereUniqueInput,
    passwordHash: string,
  ): Promise<DbUser> => {
    return prisma.user.update({
      where,
      data: { passwordHash },
    }) as Promise<DbUser>;
  },
};
