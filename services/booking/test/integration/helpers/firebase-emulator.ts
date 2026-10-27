import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { z } from "zod";

// Firebase Auth Emulator (firebase-tools). Start it before the integration
// tests, e.g. from services/booking:
//   npm run emulator:auth
// and export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099. The tests fail (never
// skip) without it. The emulator issues unsigned tokens; signature checks are
// covered by the production-mode unit tests instead.

export const EMULATOR_PROJECT_ID = process.env.FIREBASE_EMULATOR_PROJECT_ID ?? "demo-massage-it";

export const emulatorHost = (): string => {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (host === undefined || host === "") {
    throw new Error(
      "FIREBASE_AUTH_EMULATOR_HOST is not set: start the Auth Emulator (npm run emulator:auth) and export it",
    );
  }
  return host;
};

const sessionSchema = z.object({ idToken: z.string(), localId: z.string() });
const errorSchema = z.object({ error: z.object({ message: z.string() }) });

export type EmulatorSession = z.infer<typeof sessionSchema>;

const call = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
  const response = await fetch(
    `http://${emulatorHost()}/identitytoolkit.googleapis.com/v1/${path}?key=emulator-api-key`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const json: unknown = await response.json();
  return json;
};

/** A client-side Firebase action; resolves to the session or the error code. */
const session = async (
  path: string,
  body: Record<string, unknown>,
): Promise<EmulatorSession | { error: string }> => {
  const json = await call(path, { ...body, returnSecureToken: true });
  const ok = sessionSchema.safeParse(json);
  if (ok.success) {
    return ok.data;
  }
  const failed = errorSchema.safeParse(json);
  return { error: failed.success ? failed.data.error.message : "UNKNOWN" };
};

const expectSession = (result: EmulatorSession | { error: string }): EmulatorSession => {
  if ("error" in result) {
    throw new Error(`emulator call failed: ${result.error}`);
  }
  return result;
};

const googlePostBody = (claims: Record<string, unknown>) =>
  `id_token=${encodeURIComponent(JSON.stringify(claims))}&providerId=google.com`;

/** What the Firebase client SDK does in the browser, via the emulator's REST API. */
export const client = {
  signInAnonymously: async () => expectSession(await session("accounts:signUp", {})),
  signUp: async (email: string, password: string) =>
    expectSession(await session("accounts:signUp", { email, password })),
  signIn: async (email: string, password: string) =>
    expectSession(await session("accounts:signInWithPassword", { email, password })),
  /** linkWithCredential(EmailAuthProvider) for the current (anonymous) user. */
  linkEmailPassword: (idToken: string, email: string, password: string) =>
    session("accounts:update", { idToken, email, password }),
  /** signInWithPopup / linkWithPopup(GoogleAuthProvider); emulator fake Google account. */
  signInWithGoogle: async (claims: Record<string, unknown>, linkToIdToken?: string) =>
    session("accounts:signInWithIdp", {
      requestUri: "http://localhost",
      postBody: googlePostBody(claims),
      ...(linkToIdToken !== undefined ? { idToken: linkToIdToken } : {}),
    }),
};

/** Server-side Admin SDK against the emulator (what an operator would do). */
export const createEmulatorAdmin = (): { auth: Auth; close: () => Promise<void> } => {
  emulatorHost();
  const app: App = initializeApp({ projectId: EMULATOR_PROJECT_ID }, `it-admin-${randomUUID()}`);
  return { auth: getAuth(app), close: () => deleteApp(app) };
};

export const clearEmulatorAccounts = async (): Promise<void> => {
  await fetch(`http://${emulatorHost()}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/accounts`, {
    method: "DELETE",
  });
};

/** The emulator token with changed claims (still unsigned, as emulator tokens are). */
export const withClaims = (idToken: string, changes: Record<string, unknown>): string => {
  const [header = "", payload = ""] = idToken.split(".");
  const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const claims = z.record(z.string(), z.unknown()).parse(decoded);
  const updated = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url");
  return `${header}.${updated}.`;
};

/** auth_time has one-second resolution: wait so a revocation is strictly later. */
export const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1_100));
