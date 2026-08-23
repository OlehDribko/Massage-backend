import { z } from "zod";

export const subscribeToMarketingSchema = z.object({
  email: z.string().toLowerCase().trim().email(),
});

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

export type CreateSubscriberRequest = z.infer<typeof createSubscriberSchema>;
export type CreateUserRequest = z.infer<typeof createUserSchema>;
export type SubscribeToMarketingRequest = z.infer<
  typeof subscribeToMarketingSchema
>;
