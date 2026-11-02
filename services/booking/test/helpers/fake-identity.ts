import type {
  IdentityProvider,
  RevokeOutcome,
  VerifiedIdentity,
  VerifyOutcome,
} from "../../src/modules/auth/identity.js";

export const identity = (overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  uid: "uid-client",
  isAnonymous: false,
  signInProvider: "password",
  email: "client@example.invalid",
  emailVerified: true,
  name: undefined,
  issuedAt: new Date("2026-10-27T10:00:00Z"),
  ...overrides,
});

/**
 * Identity provider for HTTP tests: a token is accepted if it was registered
 * with `issue`; any other token is "invalid". `outcomes` forces a failure.
 */
export const createFakeIdentityProvider = () => {
  const tokens = new Map<string, VerifyOutcome>();
  const revoked: string[] = [];
  let revokeOutcome: RevokeOutcome = "revoked";
  let verifyCalls = 0;

  const provider: IdentityProvider = {
    verifyIdToken: (token) => {
      verifyCalls += 1;
      return Promise.resolve(tokens.get(token) ?? { ok: false, reason: "invalid" });
    },
    revokeAllSessions: (uid) => {
      if (revokeOutcome === "revoked") {
        revoked.push(uid);
      }
      return Promise.resolve(revokeOutcome);
    },
  };

  return {
    provider,
    issue: (token: string, value: VerifiedIdentity) => {
      tokens.set(token, { ok: true, identity: value });
    },
    fail: (token: string, reason: Extract<VerifyOutcome, { ok: false }>["reason"]) => {
      tokens.set(token, { ok: false, reason });
    },
    setRevokeOutcome: (outcome: RevokeOutcome) => {
      revokeOutcome = outcome;
    },
    revoked: () => [...revoked],
    verifyCalls: () => verifyCalls,
  };
};
