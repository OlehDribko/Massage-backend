import type { User } from "@prisma/client";
import type { CreateUserRequest } from "./user.schema.js";

import { hashPassword } from "../../shared/security/password.js";
import { userRepository } from "./user.repository.js";
import { AppError } from "../../shared/errors/app-error.js";
import { UserStatus } from "@prisma/client";
import emailService from "../email/email.service.js";

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

export const subscribedToMarketingService = async (
  email: string,
): Promise<{ user: User; created: boolean }> => {
  const user = await userRepository.findUserByEmail(email);

  if (user?.marketingConsent === true) {
    throw new AppError(409, "User is already subscribed to marketing");
  }

  if (!user) {
    const createdUser = await userRepository.createSubscriber({
      email,
      status: UserStatus.subscribed,
      marketingConsent: true,
    });
    try {
      await emailService.sendOffersSubscriptionConfirmation(createdUser);
    } catch (error) {
      console.error(
        "Failed to send offers subscription confirmation email:",
        error,
      );
    }

    return { user: createdUser, created: true };
  }
  const userUpdated = await userRepository.updateMarketingConsent(email, true);
  try {
    await emailService.sendOffersSubscriptionConfirmation(userUpdated);
  } catch (error) {
    console.error(
      "Failed to send offers subscription confirmation email:",
      error,
    );
  }
  return { user: userUpdated, created: false };
};
