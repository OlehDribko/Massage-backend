export type UserStatus = "subscribed" | "registered";

export interface User {
  id: string;
  name?: string;
  email: string;
  passwordHash?: string;
  status: UserStatus;
  marketingConsent: boolean;
  createdAt: Date;
  updatedAt: Date;
}
