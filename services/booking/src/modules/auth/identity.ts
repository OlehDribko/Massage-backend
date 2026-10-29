/**
 * Contract between business code and the identity provider (Firebase
 * Authentication). Business code depends only on these types; the Firebase
 * Admin SDK is used solely in src/integrations/firebase.
 */

/** Identity proven by a verified ID token. Never built from request bodies. */
export type VerifiedIdentity = {
  /** Provider user id (Firebase UID): an external identifier, not our user id. */
  uid: string;
  isAnonymous: boolean;
  /** e.g. "anonymous", "password", "google.com". */
  signInProvider: string;
  email: string | undefined;
  /** As asserted by the provider in the token; false when absent. */
  emailVerified: boolean;
  /** Display name from the provider (e.g. Google); a default only. */
  name: string | undefined;
  /** When the token was issued; orders concurrent profile updates. */
  issuedAt: Date;
};

export type IdentityFailure =
  /** Malformed, wrongly signed, wrong project, or the user no longer exists. */
  | "invalid"
  | "expired"
  /** Issued before the user's sessions were revoked. */
  | "revoked"
  /** The account is disabled (blocked) in the provider. */
  | "disabled"
  /** The provider could not be reached; the token was neither accepted nor rejected. */
  | "unavailable";

export type VerifyOutcome =
  | { ok: true; identity: VerifiedIdentity }
  | { ok: false; reason: IdentityFailure };

export type RevokeOutcome = "revoked" | "unavailable";

export type IdentityProvider = {
  /** Verifies signature, expiry, project, revocation and disabled state. */
  verifyIdToken: (token: string) => Promise<VerifyOutcome>;
  /** Signs the user out on every device (refresh tokens and current ID tokens). */
  revokeAllSessions: (uid: string) => Promise<RevokeOutcome>;
};
