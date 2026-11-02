import { randomUUID } from "node:crypto";
import { applicationDefault, cert, deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { z } from "zod";
import type { FirebaseConfig } from "../../config/config.js";
import { describeError, type Logger } from "../../logging/logger.js";
import type {
  IdentityFailure,
  IdentityProvider,
  RevokeOutcome,
  VerifyOutcome,
} from "../../modules/auth/identity.js";

// The decoded token is external data: only the claims we use are read, and
// they are validated rather than trusted by type.
const decodedTokenSchema = z.object({
  uid: z.string().min(1).max(128),
  iat: z.number().int().nonnegative(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  firebase: z.object({ sign_in_provider: z.string().min(1) }),
});

const errorCodeSchema = z.object({ code: z.string() });

// Firebase Admin SDK error codes (firebase-admin/lib/auth/error.js).
// Anything else (network, quota, credentials, internal) means the decision
// could not be made, never that the token is valid.
const failureByCode: Readonly<Record<string, IdentityFailure>> = {
  "auth/argument-error": "invalid",
  "auth/invalid-argument": "invalid",
  "auth/invalid-id-token": "invalid",
  "auth/user-not-found": "invalid",
  "auth/id-token-expired": "expired",
  "auth/id-token-revoked": "revoked",
  "auth/user-disabled": "disabled",
};

/** Maps an SDK rejection to a failure reason. Exported for tests. */
export const classifyFirebaseError = (error: unknown): IdentityFailure => {
  const parsed = errorCodeSchema.safeParse(error);
  return (parsed.success ? failureByCode[parsed.data.code] : undefined) ?? "unavailable";
};

export type FirebaseIdentityProvider = IdentityProvider & {
  /** Releases the Admin SDK app (tests, shutdown). */
  close: () => Promise<void>;
};

/**
 * Firebase Admin SDK adapter. Each instance owns a separately named Admin
 * app, so tests can create several without sharing global state.
 *
 * - verifyIdToken always runs with checkRevoked = true: the SDK verifies the
 *   signature against Google's public keys, expiry, `aud`/`iss` = this
 *   project, then reads the user record and rejects disabled users and tokens
 *   issued before revokeRefreshTokens.
 * - With FIREBASE_AUTH_EMULATOR_HOST the SDK skips signatures (the emulator
 *   issues unsigned tokens); config allows this only outside production and
 *   only with a demo- project id.
 */
export const createFirebaseIdentityProvider = (
  config: FirebaseConfig,
  logger: Logger,
): FirebaseIdentityProvider => {
  const credential =
    config.credentials.kind === "service-account"
      ? cert({
          projectId: config.projectId,
          clientEmail: config.credentials.clientEmail,
          privateKey: config.credentials.privateKey,
        })
      : config.credentials.kind === "application-default"
        ? applicationDefault()
        : undefined;

  const app: App = initializeApp(
    { projectId: config.projectId, ...(credential !== undefined ? { credential } : {}) },
    `booking-${randomUUID()}`,
  );
  const auth = getAuth(app);

  const verifyIdToken = async (token: string): Promise<VerifyOutcome> => {
    let decoded: unknown;
    try {
      decoded = await auth.verifyIdToken(token, true);
    } catch (error) {
      const reason = classifyFirebaseError(error);
      if (reason === "unavailable") {
        // describeError drops the message, which may quote the token.
        logger.error({ error: describeError(error) }, "identity provider unavailable");
      }
      return { ok: false, reason };
    }

    const claims = decodedTokenSchema.safeParse(decoded);
    if (!claims.success) {
      return { ok: false, reason: "invalid" };
    }

    const { uid, iat, email, email_verified: emailVerified, name, firebase } = claims.data;
    return {
      ok: true,
      identity: {
        uid,
        isAnonymous: firebase.sign_in_provider === "anonymous",
        signInProvider: firebase.sign_in_provider,
        email: email?.toLowerCase(),
        emailVerified: emailVerified === true && email !== undefined,
        name,
        issuedAt: new Date(iat * 1000),
      },
    };
  };

  const revokeAllSessions = async (uid: string): Promise<RevokeOutcome> => {
    try {
      await auth.revokeRefreshTokens(uid);
      return "revoked";
    } catch (error) {
      logger.error({ error: describeError(error) }, "failed to revoke sessions");
      return "unavailable";
    }
  };

  return {
    verifyIdToken,
    revokeAllSessions,
    close: () => deleteApp(app),
  };
};
