import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { MarketingMailer } from "../src/modules/email/service/email.service.js";
import { createActionTokenService } from "../src/modules/email/tokens/action-token.service.js";
import { createMarketingRouter } from "../src/modules/marketing/marketing.routes.js";
import { CONFIRMATION_COOLDOWN_MS, createMarketingService } from "../src/modules/marketing/marketing.service.js";
import { createInMemoryMarketingRepository } from "./helpers/in-memory-repositories.js";
import { createCapturingLogger } from "./helpers/logs.js";

const SECRET = "marketing-test-secret-0123456789abcdef";
const FRONTEND = "https://front.example.invalid";

type Sent = { kind: "confirm" | "confirmed"; email: string; url: string };

const tokenFrom = (url: string): string => new URL(url).searchParams.get("token") ?? "";

const setup = (options: { failSends?: boolean } = {}) => {
  const sent: Sent[] = [];
  let clock = Date.parse("2026-10-27T10:00:00Z");
  const mailer: MarketingMailer = {
    sendConfirmationRequest: (email, url) => {
      if (options.failSends === true) {
        return Promise.reject(new Error("BREVO_SENTINEL provider down"));
      }
      sent.push({ kind: "confirm", email, url });
      return Promise.resolve();
    },
    sendSubscriptionConfirmed: (email, url) => {
      sent.push({ kind: "confirmed", email, url });
      return Promise.resolve();
    },
  };
  const repo = createInMemoryMarketingRepository();
  const logs = createCapturingLogger();
  const service = createMarketingService({
    repository: repo.repository,
    mailer,
    tokens: createActionTokenService(SECRET),
    frontendUrl: FRONTEND,
    logger: logs.logger,
    now: () => clock,
  });
  const api = express.Router();
  api.use("/marketing", createMarketingRouter(service));
  const app = createApp({
    logger: logs.logger,
    isShuttingDown: () => false,
    probeReadiness: () => Promise.resolve("ready"),
    appVersion: undefined,
    corsOrigin: undefined,
    apiRouter: api,
  });
  return {
    app,
    repo,
    sent,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

const subscribe = (app: express.Express, email: string) =>
  request(app).post("/api/marketing/subscriptions").send({ email });
const confirm = (app: express.Express, token: string) =>
  request(app).post("/api/marketing/subscriptions/confirm").send({ token });
const unsubscribe = (app: express.Express, token: string) =>
  request(app).post("/api/marketing/subscriptions/unsubscribe").send({ token });

const NEUTRAL = {
  code: "SUBSCRIPTION_REQUESTED",
  message: "If this address can receive email, a confirmation link has been sent to it.",
};

describe("marketing subscription", () => {
  it("subscribes only after the emailed link is confirmed (double opt-in)", async () => {
    const { app, repo, sent } = setup();

    const response = await subscribe(app, "  Anna@Example.Invalid ");
    expect(response.status).toBe(202);
    expect(response.body).toEqual(NEUTRAL);
    expect(repo.byEmail("anna@example.invalid")?.status).toBe("pending");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url.startsWith(`${FRONTEND}/marketing/confirm?token=`)).toBe(true);

    const confirmed = await confirm(app, tokenFrom(sent[0]?.url ?? ""));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ code: "SUBSCRIBED" });
    expect(repo.byEmail("anna@example.invalid")?.status).toBe("subscribed");
    expect(sent[1]).toMatchObject({ kind: "confirmed", email: "anna@example.invalid" });
    expect(sent[1]?.url.startsWith(`${FRONTEND}/unsubscribe?token=`)).toBe(true);
  });

  it("answers identically for new, pending and subscribed addresses", async () => {
    const { app, sent } = setup();
    await subscribe(app, "known@example.invalid");
    await confirm(app, tokenFrom(sent[0]?.url ?? ""));

    for (const email of ["known@example.invalid", "fresh@example.invalid", "fresh@example.invalid"]) {
      const response = await subscribe(app, email);
      expect(response.status).toBe(202);
      expect(response.body).toEqual(NEUTRAL);
    }
    // Already subscribed: no further mail. Pending: one mail per cooldown.
    expect(sent.filter((mail) => mail.email === "known@example.invalid")).toHaveLength(2);
    expect(sent.filter((mail) => mail.email === "fresh@example.invalid")).toHaveLength(1);
  });

  it("limits confirmation emails per address and invalidates the previous link", async () => {
    const { app, sent, advance } = setup();
    await subscribe(app, "a@example.invalid");
    await subscribe(app, "a@example.invalid");
    expect(sent).toHaveLength(1);

    advance(CONFIRMATION_COOLDOWN_MS + 1);
    await subscribe(app, "a@example.invalid");
    expect(sent).toHaveLength(2);

    const old = await confirm(app, tokenFrom(sent[0]?.url ?? ""));
    expect(old.status).toBe(400);
    expect(old.body).toEqual({ message: "Invalid or expired link", code: "INVALID_ACTION_TOKEN" });
  });

  it("a confirmation link is single-use and cannot re-subscribe after unsubscribing", async () => {
    const { app, repo, sent } = setup();
    await subscribe(app, "b@example.invalid");
    const confirmToken = tokenFrom(sent[0]?.url ?? "");
    await confirm(app, confirmToken);

    const replay = await confirm(app, confirmToken);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ code: "ALREADY_SUBSCRIBED" });

    const unsubscribeToken = tokenFrom(sent[1]?.url ?? "");
    expect((await unsubscribe(app, unsubscribeToken)).status).toBe(200);
    expect(repo.byEmail("b@example.invalid")?.status).toBe("unsubscribed");

    expect((await confirm(app, confirmToken)).status).toBe(400);
    expect(repo.byEmail("b@example.invalid")?.status).toBe("unsubscribed");

    // Unsubscribing again is harmless.
    expect((await unsubscribe(app, unsubscribeToken)).status).toBe(200);
  });

  it("unsubscribe answers the same for unknown subscriptions (no 500, no information)", async () => {
    const { app } = setup();
    const token = createActionTokenService(SECRET).createToken(
      "marketing_unsubscribe",
      "00000000-0000-4000-8000-000000000000",
    );

    const response = await unsubscribe(app, token);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ code: "UNSUBSCRIBED" });
    expect(response.text).toContain("bookings are not affected");
  });

  it.each([
    ["wrong purpose", () => createActionTokenService(SECRET).createToken("marketing_unsubscribe", "00000000-0000-4000-8000-000000000000")],
    ["other secret", () => createActionTokenService(`${SECRET}-other`).createToken("marketing_confirm", "00000000-0000-4000-8000-000000000000", "n")],
    ["expired", () => jwt.sign({ userId: "00000000-0000-4000-8000-000000000000", purpose: "marketing_confirm", nonce: "n" }, SECRET, { issuer: "massage-backend", expiresIn: -10 })],
    ["alg none", () => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"userId":"x","purpose":"marketing_confirm","nonce":"n","iss":"massage-backend"}').toString("base64url")}.`],
    ["no nonce", () => createActionTokenService(SECRET).createToken("marketing_confirm", "00000000-0000-4000-8000-000000000000")],
    ["non-uuid subject", () => createActionTokenService(SECRET).createToken("marketing_confirm", "legacy-id", "n")],
  ])("rejects a confirmation token: %s", async (_label, makeToken) => {
    const { app } = setup();
    const response = await confirm(app, makeToken());
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: "Invalid or expired link", code: "INVALID_ACTION_TOKEN" });
  });

  it("keeps answering neutrally when sending fails, allows a retry and logs no provider text", async () => {
    const { app, repo, logs } = setup({ failSends: true });

    const response = await subscribe(app, "c@example.invalid");

    expect(response.status).toBe(202);
    expect(response.body).toEqual(NEUTRAL);
    expect(repo.byEmail("c@example.invalid")?.confirmationSentAt).toBeNull();
    expect(logs.raw()).toContain("failed to send marketing confirmation email");
    expect(logs.raw()).not.toContain("BREVO_SENTINEL");
    expect(logs.raw()).not.toContain("c@example.invalid");
  });

  it("validates input strictly", async () => {
    const { app } = setup();
    for (const body of [{ email: "nope" }, { email: "a@example.invalid", consent: true }, {}]) {
      expect((await request(app).post("/api/marketing/subscriptions").send(body)).status).toBe(400);
    }
  });
});
