import { z } from "zod";

export const subscribeToMarketingSchema = z
  .object({
    email: z.string().toLowerCase().trim().email(),
  })
  .strict();

export const resendEmailVerificationSchema = z
  .object({
    email: z.string().toLowerCase().trim().email(),
  })
  .strict();

export const createSubscriberSchema = z.object({
  name: z.string().min(3).max(40),
  email: z.string().toLowerCase().trim().email(),
  password: z.string().min(8).max(25),
});

export const createUserSchema = z.object({
  name: z.string().min(3).max(40),
  email: z.string().toLowerCase().trim().email(),
  password: z.string().min(8).max(25),
  marketingConsent: z.boolean(),
});

export const forgotPasswordSchema = z
  .object({
    email: z.string().toLowerCase().trim().email(),
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(8).max(25),
  })
  .strict();

export type CreateSubscriberRequest = z.infer<typeof createSubscriberSchema>;
export type CreateUserRequest = z.infer<typeof createUserSchema>;
export type SubscribeToMarketingRequest = z.infer<
  typeof subscribeToMarketingSchema
>;
export type ResendEmailVerificationRequest = z.infer<
  typeof resendEmailVerificationSchema
>;
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordSchema>;
