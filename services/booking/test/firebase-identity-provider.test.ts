import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyFirebaseError,
  createFirebaseIdentityProvider,
  type FirebaseIdentityProvider,
} from "../src/integrations/firebase/firebase-identity-provider.js";
import { createCapturingLogger } from "./helpers/logs.js";

// Real Firebase Admin SDK in production mode (no emulator). These tokens are
// rejected by the SDK's own checks; a rejection that needs Google's public
// keys (unknown "kid") is "invalid" whether or not the keys can be fetched.
// Valid tokens, expiry, revocation and disabled users: Auth Emulator
// integration tests (test/integration/auth-profiles.test.ts).

const PROJECT_ID = "massage-unit-test";
const TOKEN_SENTINEL = "TOKENSENTINEL";

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

const now = () => Math.floor(Date.now() / 1000);

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: `https://securetoken.google.com/${PROJECT_ID}`,
  aud: PROJECT_ID,
  auth_time: now() - 10,
  sub: `uid-${TOKEN_SENTINEL}`,
  iat: now() - 10,
  exp: now() + 3600,
  firebase: { sign_in_provider: "password" },
  ...overrides,
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const signedByUs = (payload: Record<string, unknown>) =>
  jwt.sign(payload, privateKey, { algorithm: "RS256", keyid: "not-a-google-key" });

describe("Firebase identity provider (production mode)", () => {
  const logs = createCapturingLogger();
  let provider: FirebaseIdentityProvider;

  beforeAll(() => {
    // The SDK would accept unsigned tokens if this were set.
    expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBeUndefined();
    provider = createFirebaseIdentityProvider(
      { projectId: PROJECT_ID, credentials: { kind: "application-default" } },
      logs.logger,
    );
  });

  afterAll(async () => {
    await provider.close();
  });

  it.each([
    ["garbage", `not-a-jwt-${TOKEN_SENTINEL}`],
    ["unsigned emulator-style token", `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims())}.`],
    ["HS256 token without kid", jwt.sign(claims(), "shared-secret", { algorithm: "HS256" })],
    [
      "custom token instead of an ID token",
      signedByUs(claims({ aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit" })),
    ],
    ["token of another Firebase project", signedByUs(claims({ aud: "other-project", iss: "https://securetoken.google.com/other-project" }))],
    ["wrong issuer", signedByUs(claims({ iss: "https://evil.example.invalid/" }))],
    ["forged signature (key not published by Google)", signedByUs(claims())],
  ])("rejects a %s as invalid", async (_label, token) => {
    expect(await provider.verifyIdToken(token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("never logs the token", () => {
    expect(logs.raw()).not.toContain(TOKEN_SENTINEL);
  });
});

describe("classifyFirebaseError", () => {
  it.each([
    ["auth/argument-error", "invalid"],
    ["auth/invalid-id-token", "invalid"],
    ["auth/user-not-found", "invalid"],
    ["auth/id-token-expired", "expired"],
    ["auth/id-token-revoked", "revoked"],
    ["auth/user-disabled", "disabled"],
    ["auth/internal-error", "unavailable"],
    ["auth/invalid-credential", "unavailable"],
    ["app/network-error", "unavailable"],
  ])("maps %s to %s", (code, expected) => {
    expect(classifyFirebaseError(Object.assign(new Error("x"), { code }))).toBe(expected);
  });

  it("treats errors without a code as unavailable, never as valid", () => {
    expect(classifyFirebaseError(new Error("boom"))).toBe("unavailable");
    expect(classifyFirebaseError("boom")).toBe("unavailable");
  });
});
