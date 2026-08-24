import { prisma } from "../../shared/database/prisma.js";

import type { User } from "@prisma/client";
import type { CreateSubscriberData } from "./user.types.js";
import type { CreateUserData } from "./user.types.js";

export const userRepository = {
  createUser: async (userData: CreateUserData): Promise<User> => {
    return prisma.user.create({ data: userData });
  },

  findUserByEmail: async (email: string): Promise<User | null> => {
    return prisma.user.findUnique({ where: { email } });
  },
  updateMarketingConsent: async (
    email: string,
    marketingConsent: boolean,
  ): Promise<User> => {
    return prisma.user.update({
      where: { email },
      data: { marketingConsent },
    });
  },
  getAllUsers: async () => {
    return prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        marketingConsent: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  },
  createSubscriber: async (data: CreateSubscriberData) => {
    return prisma.user.create({ data });
  },
};
