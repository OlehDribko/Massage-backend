import type { Request, RequestHandler } from "express";
import type { IdentityFailure, IdentityProvider, VerifiedIdentity } from "../../modules/auth/identity.js";
import { AppError } from "../../shared/errors/app-error.js";

const identities = new WeakMap<Request, VerifiedIdentity>();

/** Firebase ID tokens are ~1 kB; anything far larger is rejected unparsed. */
export const MAX_ID_TOKEN_LENGTH = 4096;

const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

type Rejection = { status: number; code: string; message: string };

// Fixed messages only: nothing from the token or the provider's error text.
const rejectionByReason: Readonly<Record<IdentityFailure, Rejection>> = {
  invalid: { status: 401, code: "INVALID_TOKEN", message: "Invalid ID token" },
  expired: { status: 401, code: "TOKEN_EXPIRED", message: "ID token expired; refresh it and retry" },
  revoked: { status: 401, code: "SESSION_REVOKED", message: "Session revoked; sign in again" },
  disabled: { status: 403, code: "ACCOUNT_DISABLED", message: "Account disabled" },
  unavailable: {
    status: 503,
    code: "AUTH_UNAVAILABLE",
    message: "Authentication is temporarily unavailable; retry later",
  },
};

/** Identity set by `authenticate`; undefined on routes without it. */
export const getIdentity = (req: Request): VerifiedIdentity | undefined => identities.get(req);

/** Like getIdentity, for handlers that run only after `authenticate`. */
export const requireIdentity = (req: Request): VerifiedIdentity => {
  const identity = identities.get(req);
  if (identity === undefined) {
    throw new AppError(401, "Authentication required", { code: "AUTH_REQUIRED" });
  }
  return identity;
};

/**
 * Requires `Authorization: Bearer <Firebase ID token>`. The token is passed
 * only to the identity provider: it is not logged, echoed or stored.
 */
export const createAuthenticate = (provider: IdentityProvider): RequestHandler => {
  return async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");

    const header = req.get("authorization");
    if (header === undefined || header.trim() === "") {
      res.setHeader("WWW-Authenticate", "Bearer");
      next(new AppError(401, "Authentication required", { code: "AUTH_REQUIRED" }));
      return;
    }

    const match = header.length <= MAX_ID_TOKEN_LENGTH + 7 ? BEARER.exec(header) : null;
    const token = match?.[1];
    if (token === undefined) {
      res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      next(new AppError(401, "Invalid ID token", { code: "INVALID_TOKEN" }));
      return;
    }

    let outcome;
    try {
      outcome = await provider.verifyIdToken(token);
    } catch {
      outcome = { ok: false, reason: "unavailable" } satisfies { ok: false; reason: IdentityFailure };
    }

    if (!outcome.ok) {
      const rejection = rejectionByReason[outcome.reason];
      if (rejection.status === 401) {
        res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      }
      next(
        new AppError(rejection.status, rejection.message, {
          code: rejection.code,
          ...(outcome.reason === "unavailable" ? { details: { retryAfterSeconds: 5 } } : {}),
        }),
      );
      return;
    }

    identities.set(req, outcome.identity);
    next();
  };
};
