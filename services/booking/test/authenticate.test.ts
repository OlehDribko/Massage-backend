import request from "supertest";
import { describe, expect, it } from "vitest";
import { MAX_ID_TOKEN_LENGTH } from "../src/http/auth/authenticate.js";
import type { IdentityFailure } from "../src/modules/auth/identity.js";
import { identity } from "./helpers/fake-identity.js";
import { createProfileTestApp } from "./helpers/profile-app.js";

const SENTINEL = "SENTINELTOKEN";

describe("authenticate (Authorization: Bearer <Firebase ID token>)", () => {
  it("requires a token: 401 AUTH_REQUIRED with WWW-Authenticate, no caching", async () => {
    const { app, identities } = createProfileTestApp();

    const response = await request(app).get("/api/me");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: "Authentication required", code: "AUTH_REQUIRED" });
    expect(response.get("WWW-Authenticate")).toBe("Bearer");
    expect(response.get("Cache-Control")).toBe("no-store");
    expect(identities.verifyCalls()).toBe(0);
  });

  it.each([
    ["another scheme", `Basic ${SENTINEL}`],
    ["no token", "Bearer "],
    ["two tokens", `Bearer ${SENTINEL} ${SENTINEL}`],
    ["characters outside a JWT", `Bearer ${SENTINEL}"<script>`],
    ["an oversized token", `Bearer ${"a".repeat(MAX_ID_TOKEN_LENGTH + 1)}`],
  ])("rejects %s as INVALID_TOKEN without calling the provider", async (_label, header) => {
    const { app, identities, logs } = createProfileTestApp();

    const response = await request(app).get("/api/me").set("Authorization", header);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: "Invalid ID token", code: "INVALID_TOKEN" });
    expect(identities.verifyCalls()).toBe(0);
    expect(response.text + logs.raw()).not.toContain(SENTINEL);
  });

  const failures: [IdentityFailure, number, string][] = [
    ["invalid", 401, "INVALID_TOKEN"],
    ["expired", 401, "TOKEN_EXPIRED"],
    ["revoked", 401, "SESSION_REVOKED"],
    ["disabled", 403, "ACCOUNT_DISABLED"],
    ["unavailable", 503, "AUTH_UNAVAILABLE"],
  ];

  it.each(failures)("maps a %s token to %i %s", async (reason, status, code) => {
    const { app, identities, logs } = createProfileTestApp();
    const token = `${SENTINEL}.${reason}`;
    identities.fail(token, reason);

    const response = await request(app).post("/api/me/sync").set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ code });
    if (status === 401) {
      expect(response.get("WWW-Authenticate")).toBe('Bearer error="invalid_token"');
    }
    if (reason === "unavailable") {
      expect(response.get("Retry-After")).toBe("5");
    }
    expect(response.text + logs.raw()).not.toContain(SENTINEL);
  });

  it("accepts a verified token and never logs it", async () => {
    const { app, identities, logs } = createProfileTestApp();
    identities.issue(`${SENTINEL}.ok`, identity());

    const response = await request(app).post("/api/me/sync").set("Authorization", `Bearer ${SENTINEL}.ok`);

    expect(response.status).toBe(200);
    expect(response.text + logs.raw()).not.toContain(SENTINEL);
  });
});
