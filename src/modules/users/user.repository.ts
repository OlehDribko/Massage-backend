import type { User } from "@prisma/client";
import { UserStatus } from "@prisma/client";

import { prisma } from "../../shared/database/prisma.js";
import { hashPassword } from "../../shared/security/password.js";
import type { CreateUserRequest } from "./user.schema.js";

export const userRepository = {
  createUser: async (input: CreateUserRequest): Promise<User> => {
    const passwordHash = await hashPassword(input.password);

    return prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash,
        status: UserStatus.registered,
        marketingConsent: input.marketingConsent,
      },
    });
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
};
