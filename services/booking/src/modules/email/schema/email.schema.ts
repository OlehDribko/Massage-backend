import { z } from "zod";

export const actionTokenSchema = z
  .object({
    token: z.string().min(1),
  })
  .strict();

export type ActionTokenRequest = z.infer<typeof actionTokenSchema>;

/** @deprecated use actionTokenSchema */
export const unsubscribeTokenSchema = actionTokenSchema;
