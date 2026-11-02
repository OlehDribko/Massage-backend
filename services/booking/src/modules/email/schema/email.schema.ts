import { z } from "zod";

export const actionTokenSchema = z
  .object({
    token: z.string().min(1).max(2048),
  })
  .strict();

export type ActionTokenRequest = z.infer<typeof actionTokenSchema>;
