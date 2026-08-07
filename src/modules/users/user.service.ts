import type { User } from "@prisma/client";
import type { CreateUserRequest } from "./user.schema.js";
import { userRepository } from "./user.repository.js";
import { AppError } from "../../shared/errors/app-error.js";

export const registerUser = async (input: CreateUserRequest): Promise<User> => {
  const existingUser = await userRepository.findUserByEmail(input.email);
  if (existingUser) {
    throw new AppError(409, "User with this email already exists");
  }
  return userRepository.createUser(input);
};
