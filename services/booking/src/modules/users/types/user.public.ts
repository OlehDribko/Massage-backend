import type { DbUser } from "./user.types.js";

export type PublicUser = {
  id: string;
  name: string | null;
  email: string;
  status: DbUser["status"];
  marketingConsent: boolean;
  emailVerified: boolean;
};

export const toPublicUser = (user: DbUser): PublicUser => ({
  id: user.id,
  name: user.name,
  email: user.email,
  status: user.status,
  marketingConsent: user.marketingConsent,
  emailVerified: user.emailVerified,
});
