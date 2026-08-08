import type { User } from "@prisma/client";
import type { CreateUserRequest } from "./user.schema.js";
import { hashPassword } from "../../shared/security/password.js";
import { userRepository } from "./user.repository.js";
import { AppError } from "../../shared/errors/app-error.js";
import { UserStatus } from "@prisma/client";

export const registerUser = async (input: CreateUserRequest): Promise<User> => {
  const existingUser = await userRepository.findUserByEmail(input.email);
  if (existingUser) {
    throw new AppError(409, "User with this email already exists");
  }
  const passwordHash = await hashPassword(input.password);
  const userData = {
    name: input.name,
    email: input.email,
    passwordHash,
    status: UserStatus.registered,
    marketingConsent: input.marketingConsent,
  };
  return userRepository.createUser(userData);
};
