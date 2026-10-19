import type { Prisma, PrismaClient } from "@prisma/client";
import type { CreateSubscriberData } from "../types/user.types.js";
import type { CreateUserData } from "../types/user.types.js";
import type { DbUser } from "../types/user.types.js";
import type { UpgradeSubscriberData } from "../types/user.types.js";
import { EMAIL_VERIFICATION_RESEND_COOLDOWN_MS } from "../email-verification/constants.js";

export type UserRepository = ReturnType<typeof createUserRepository>;

export const createUserRepository = (prisma: PrismaClient) => ({
  createUser: async (userData: CreateUserData): Promise<DbUser> => {
    return prisma.user.create({ data: userData });
  },

  findUser: async (
    where: Prisma.UserWhereUniqueInput,
  ): Promise<DbUser | null> => {
    return prisma.user.findUnique({ where });
  },
  updateMarketingConsent: async (
    where: Prisma.UserWhereUniqueInput,
    marketingConsent: boolean,
  ): Promise<DbUser> => {
    return prisma.user.update({
      where,
      data: { marketingConsent },
    });
  },
  markEmailVerified: async (
    where: Prisma.UserWhereUniqueInput,
  ): Promise<DbUser> => {
    return prisma.user.update({
      where,
      data: { emailVerified: true },
    });
  },

  claimEmailVerificationSend: async (
    userId: string,
    cooldownMs: number = EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  ): Promise<DbUser | null> => {
    const cooldownSince = new Date(Date.now() - cooldownMs);

    const result = await prisma.user.updateMany({
      where: {
        id: userId,
        emailVerified: false,
        OR: [
          { emailVerificationSentAt: null },
          { emailVerificationSentAt: { lt: cooldownSince } },
        ],
      },
      data: { emailVerificationSentAt: new Date() },
    });

    if (result.count === 0) {
      return null;
    }

    return prisma.user.findUnique({
      where: { id: userId },
    });
  },

  markEmailVerificationSendAttempt: async (
    userId: string,
  ): Promise<DbUser | null> => {
    const result = await prisma.user.updateMany({
      where: {
        id: userId,
        emailVerified: false,
      },
      data: { emailVerificationSentAt: new Date() },
    });

    if (result.count === 0) {
      return null;
    }

    return prisma.user.findUnique({
      where: { id: userId },
    });
  },
  getAllUsers: async (): Promise<Omit<DbUser, "passwordHash">[]> => {
    return prisma.user.findMany({
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
    });
  },
  createSubscriber: async (data: CreateSubscriberData): Promise<DbUser> => {
    return prisma.user.create({ data });
  },
  upgradeSubscriberToRegistered: async (
    where: Prisma.UserWhereUniqueInput,
    data: UpgradeSubscriberData,
  ): Promise<DbUser> => {
    return prisma.user.update({
      where,
      data,
    });
  },
  updatePassword: async (
    where: Prisma.UserWhereUniqueInput,
    passwordHash: string,
  ): Promise<DbUser> => {
    return prisma.user.update({
      where,
      data: { passwordHash },
    });
  },
});
