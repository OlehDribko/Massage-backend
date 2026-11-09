import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/config.js";
import { isAllowedOrigin, loadCorsPolicy, type CorsPolicy } from "../src/http/cors.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { createCapturingLogger } from "./helpers/logs.js";

// CORS: exact origins and anchored patterns for the preview deployments of
// one Vercel project; other origins get no CORS headers.

const PRODUCTION = "https://massage-e9zb.vercel.app";
const PREVIEW = "https://massage-e9zb-3ne7cu4qh-olehdrs-projects.vercel.app";
const LOCAL = "http://localhost:3000";
const PREVIEW_PATTERN = String.raw`^https://massage-e9zb-[a-z0-9]+-olehdrs-projects\.vercel\.app$`;

const STAGING = { allowedOrigins: `${PRODUCTION},${LOCAL}`, allowedOriginPatterns: PREVIEW_PATTERN, frontendUrl: LOCAL };

const policyOf = (env: Parameters<typeof loadCorsPolicy>[0]): CorsPolicy | undefined => {
  const result = loadCorsPolicy(env);
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result.policy;
};

const errorsOf = (env: Parameters<typeof loadCorsPolicy>[0]): string[] => {
  const result = loadCorsPolicy(env);
  if (result.ok) {
    throw new Error("expected invalid CORS settings");
  }
  return result.errors;
};

const appWith = (cors: CorsPolicy | undefined) => {
  const router = Router();
  router.post("/me/sync", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  router.get("/busy", (_req, res) => {
    res.set("Retry-After", "2").set("Idempotent-Replayed", "true").status(503).json({ code: "CALENDAR_BUSY" });
  });
  router.get("/private", () => {
    throw new AppError(401, "Authentication required", { code: "AUTH_REQUIRED" });
  });
  return createApp({
    logger: createCapturingLogger().logger,
    isShuttingDown: () => false,
    probeReadiness: () => Promise.resolve("ready"),
    appVersion: undefined,
    cors,
    apiRouter: router,
  });
};

const preflight = (app: ReturnType<typeof appWith>, origin: string, method: string, headers = "authorization,content-type,idempotency-key") =>
  request(app)
    .options("/api/me/sync")
    .set("Origin", origin)
    .set("Access-Control-Request-Method", method)
    .set("Access-Control-Request-Headers", headers);

describe("CORS policy", () => {
  const staging = policyOf(STAGING);
  if (staging === undefined) {
    throw new Error("no policy");
  }

  it("allows the listed origins, previews of this project and nothing else", () => {
    for (const origin of [PRODUCTION, LOCAL, PREVIEW, "https://massage-e9zb-a1b2c3-olehdrs-projects.vercel.app"]) {
      expect(isAllowedOrigin(staging, origin), origin).toBe(true);
    }
    for (const origin of [
      "https://evil.vercel.app",
      "https://massage-e9zb-x-other-projects.vercel.app",
      "https://massage-e9zb-3ne7cu4qh-olehdrs-projects.vercel.app.evil.com",
      "https://evil.com/https://massage-e9zb.vercel.app",
      "http://massage-e9zb-3ne7cu4qh-olehdrs-projects.vercel.app",
      "https://massage-e9zb-3NE7-olehdrs-projects.vercel.app",
      "https://massage-e9zb-git-main-olehdrs-projects.vercel.app",
      "http://localhost:3001",
      `${PRODUCTION}/`,
      "null",
      `https://massage-e9zb-${"a".repeat(400)}-olehdrs-projects.vercel.app`,
    ]) {
      expect(isAllowedOrigin(staging, origin), origin).toBe(false);
    }
  });

  it("without the new variables falls back to the origin of FRONTEND_URL; without any of them CORS is off", () => {
    expect(policyOf({ allowedOrigins: undefined, allowedOriginPatterns: undefined, frontendUrl: LOCAL })).toEqual({ origins: [LOCAL], patterns: [] });
    expect(policyOf({ allowedOrigins: " , ", allowedOriginPatterns: "", frontendUrl: "https://front.example.com/app/" })).toEqual({
      origins: ["https://front.example.com"],
      patterns: [],
    });
    expect(policyOf({ allowedOrigins: undefined, allowedOriginPatterns: undefined, frontendUrl: undefined })).toBeUndefined();
    // The list replaces FRONTEND_URL for CORS (it stays the base of email links).
    expect(policyOf({ allowedOrigins: PRODUCTION, allowedOriginPatterns: undefined, frontendUrl: LOCAL })).toEqual({ origins: [PRODUCTION], patterns: [] });
  });

  it("refuses invalid entries with the variable, the position and the rule, never the value", () => {
    const origins = errorsOf({
      allowedOrigins: `${PRODUCTION}, https://bad.example.com/, *.vercel.app, https://a.example.com/path, ftp://files.example.com, https://UPPER.example.com`,
      allowedOriginPatterns: undefined,
      frontendUrl: undefined,
    });
    expect(origins.map((error) => error.split(":")[0])).toEqual([1, 2, 3, 4, 5].map((index) => `CORS_ALLOWED_ORIGINS[${String(index)}]`));
    expect(origins.join("\n")).not.toMatch(/bad\.example|vercel|files\.example|UPPER/);

    const patterns = errorsOf({
      allowedOrigins: undefined,
      allowedOriginPatterns: [
        String.raw`https://massage\.example\.com$`,
        String.raw`^https://.*\.vercel\.app$`,
        String.raw`^https://[a-z]+\.vercel\.app`,
        String.raw`^https://a\.example\.com$|^https://b\.example\.com$`,
        String.raw`^https://[a-z\.example\.com$`,
        String.raw`^http://[a-z]+\.example\.com$`,
      ].join(","),
      frontendUrl: undefined,
    });
    expect(patterns.map((error) => error.split(":")[0])).toEqual([0, 1, 2, 3, 4, 5].map((index) => `CORS_ALLOWED_ORIGIN_PATTERNS[${String(index)}]`));
    expect(patterns.join("\n")).not.toContain("vercel");

    const tooMany = Array.from({ length: 21 }, (_, index) => `https://a${String(index)}.example.com`).join(",");
    expect(errorsOf({ allowedOrigins: tooMany, allowedOriginPatterns: undefined, frontendUrl: undefined })).toEqual([
      "CORS_ALLOWED_ORIGINS: at most 20 entries",
    ]);
  });

  it("an invalid origin stops the configuration with a clear error and no secrets", () => {
    const result = loadConfig({
      DATABASE_URL: "postgresql://user:db-secret-value@127.0.0.1:5432/booking",
      CORS_ALLOWED_ORIGINS: "https://ok.example.com,https://broken.example.com/",
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        "CORS_ALLOWED_ORIGINS[1]: must be an exact origin such as https://app.example.com (scheme, lowercase host, optional port; no path, no trailing slash, no wildcard)",
      ],
    });
  });

  it("loads the staging settings from env", () => {
    const result = loadConfig({
      DATABASE_URL: "postgresql://user:db-secret-value@127.0.0.1:5432/booking",
      FRONTEND_URL: LOCAL,
      CORS_ALLOWED_ORIGINS: `${PRODUCTION},${LOCAL}`,
      CORS_ALLOWED_ORIGIN_PATTERNS: PREVIEW_PATTERN,
    });
    expect(result.ok && result.config.cors).toEqual({ origins: [PRODUCTION, LOCAL], patterns: [new RegExp(PREVIEW_PATTERN)] });
  });
});

describe("CORS over HTTP", () => {
  const app = appWith(policyOf(STAGING));

  it("preflight from a listed origin, a preview and localhost passes for every method and the API headers", async () => {
    for (const origin of [PRODUCTION, PREVIEW, LOCAL]) {
      for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
        const response = await preflight(app, origin, method);
        expect(response.status, `${origin} ${method}`).toBe(204);
        expect(response.headers["access-control-allow-origin"]).toBe(origin);
        expect(response.headers["access-control-allow-methods"]).toBe("GET,HEAD,PUT,PATCH,POST,DELETE");
        expect(response.headers["access-control-allow-headers"]).toBe("Authorization,Content-Type,Idempotency-Key");
        expect(response.headers["access-control-max-age"]).toBe("600");
        expect(response.headers.vary).toContain("Origin");
        expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
      }
    }
  });

  it("responses, errors included, carry the origin and expose Retry-After and Idempotent-Replayed", async () => {
    const ok = await request(app).post("/api/me/sync").set("Origin", PREVIEW).expect(200);
    expect(ok.headers["access-control-allow-origin"]).toBe(PREVIEW);
    expect(ok.headers["access-control-expose-headers"]).toBe("Retry-After,Idempotent-Replayed");

    const busy = await request(app).get("/api/busy").set("Origin", PRODUCTION).expect(503);
    expect(busy.headers["access-control-allow-origin"]).toBe(PRODUCTION);
    expect(busy.headers["access-control-expose-headers"]).toBe("Retry-After,Idempotent-Replayed");
    expect(busy.headers["retry-after"]).toBe("2");

    const unauthorized = await request(app).get("/api/private").set("Origin", LOCAL).expect(401);
    expect(unauthorized.headers["access-control-allow-origin"]).toBe(LOCAL);
  });

  it("another origin (any other *.vercel.app too) gets no CORS headers and no 500", async () => {
    for (const origin of ["https://evil.vercel.app", "https://massage-e9zb-x-other-projects.vercel.app", "https://example.com"]) {
      const response = await preflight(app, origin, "POST");
      expect(response.status, origin).toBeLessThan(500);
      expect(response.headers["access-control-allow-origin"], origin).toBeUndefined();
      expect(response.headers["access-control-allow-methods"], origin).toBeUndefined();

      const post = await request(app).post("/api/me/sync").set("Origin", origin).expect(200);
      expect(post.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
  });

  it("requests without Origin (curl, the Next.js server) work as before, without CORS headers", async () => {
    const response = await request(app).post("/api/me/sync").expect(200);
    expect(response.body).toEqual({ ok: true });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("the FRONTEND_URL fallback allows only that origin", async () => {
    const fallback = appWith(policyOf({ allowedOrigins: undefined, allowedOriginPatterns: undefined, frontendUrl: LOCAL }));
    expect((await preflight(fallback, LOCAL, "POST")).headers["access-control-allow-origin"]).toBe(LOCAL);
    expect((await preflight(fallback, PREVIEW, "POST")).headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("no policy: no CORS headers at all", async () => {
    const response = await preflight(appWith(undefined), LOCAL, "POST");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
