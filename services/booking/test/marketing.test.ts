import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { MailOutcome, MarketingMailer } from "../src/modules/email/service/email.service.js";
import { createActionTokenService } from "../src/modules/email/tokens/action-token.service.js";
import { MARKETING_CONSENT_TEXT_VERSION, type ConsentRequest } from "../src/modules/marketing/consent.js";
import { createMarketingRouter } from "../src/modules/marketing/marketing.routes.js";
import { CONFIRMATION_COOLDOWN_MS, createMarketingService, rateLimitBlockMs } from "../src/modules/marketing/marketing.service.js";
import { createInMemoryMarketingRepository } from "./helpers/in-memory-repositories.js";
import { createCapturingLogger } from "./helpers/logs.js";

const SECRET = "marketing-test-secret-0123456789abcdef";
const FRONTEND = "https://front.example.invalid";

type Sent = { kind: "confirm" | "confirmed"; email: string; url: string; key: string };

const tokenFrom = (url: string): string => new URL(url).searchParams.get("token") ?? "";

const setup = (options: { failSends?: boolean } = {}) => {
  const sent: Sent[] = [];
  let clock = Date.parse("2026-10-27T10:00:00Z");
  // Outcome of the next confirmation requests; "accepted" records the mail.
  let outcome: MailOutcome = options.failSends === true ? { kind: "not_sent", code: "provider_rejected" } : { kind: "accepted" };
  const attempts: string[] = [];
  const mailer: MarketingMailer = {
    sendConfirmationRequest: (email, url, key) => {
      attempts.push(key);
      if (outcome.kind === "accepted") {
        sent.push({ kind: "confirm", email, url, key });
      }
      return Promise.resolve(outcome);
    },
    sendSubscriptionConfirmed: (email, url, key) => {
      sent.push({ kind: "confirmed", email, url, key });
      return Promise.resolve({ kind: "accepted" });
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
    service,
    repo,
    sent,
    attempts,
    setOutcome: (next: MailOutcome) => {
      outcome = next;
    },
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

const subscribe = (app: express.Express, email: string, consentTextVersion = MARKETING_CONSENT_TEXT_VERSION) =>
  request(app).post("/api/marketing/subscriptions").send({ email, consentTextVersion });
const confirm = (app: express.Express, token: string) =>
  request(app).post("/api/marketing/subscriptions/confirm").send({ token });
const unsubscribe = (app: express.Express, token: string) =>
  request(app).post("/api/marketing/subscriptions/unsubscribe").send({ token });

const NEUTRAL = {
  code: "SUBSCRIPTION_REQUESTED",
  message: "If this address can receive email and is not subscribed yet, a confirmation link has been sent to it.",
};

describe("marketing subscription", () => {
  it("subscribes only after the emailed link is confirmed (double opt-in)", async () => {
    const { app, repo, sent } = setup();

    const response = await subscribe(app, "  Anna@Example.Invalid ");
    expect(response.status).toBe(202);
    expect(response.body).toEqual(NEUTRAL);
    expect(repo.byEmail("anna@example.invalid")).toMatchObject({
      subscribed: false,
      consentGivenAt: null,
      confirmationSource: "subscription_form",
      confirmationTextVersion: MARKETING_CONSENT_TEXT_VERSION,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url.startsWith(`${FRONTEND}/marketing/confirm?token=`)).toBe(true);

    const confirmed = await confirm(app, tokenFrom(sent[0]?.url ?? ""));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ code: "SUBSCRIBED" });
    expect(repo.byEmail("anna@example.invalid")).toMatchObject({
      subscribed: true,
      consentSource: "subscription_form",
      consentTextVersion: MARKETING_CONSENT_TEXT_VERSION,
      unsubscribedAt: null,
      confirmationNonce: null,
    });
    expect(repo.byEmail("anna@example.invalid")?.consentGivenAt).toBeInstanceOf(Date);
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
    expect(repo.byEmail("b@example.invalid")).toMatchObject({ subscribed: false, consentSource: "subscription_form" });
    const unsubscribedAt = repo.byEmail("b@example.invalid")?.unsubscribedAt;
    expect(unsubscribedAt).toBeInstanceOf(Date);

    expect((await confirm(app, confirmToken)).status).toBe(400);
    expect(repo.byEmail("b@example.invalid")?.subscribed).toBe(false);

    // Unsubscribing again is harmless and keeps the original date.
    expect((await unsubscribe(app, unsubscribeToken)).status).toBe(200);
    expect(repo.byEmail("b@example.invalid")?.unsubscribedAt).toEqual(unsubscribedAt);

    // Subscribing again needs a new explicit request and a new confirmation.
    expect((await subscribe(app, "b@example.invalid")).status).toBe(202);
    expect(repo.byEmail("b@example.invalid")?.subscribed).toBe(false);
    expect((await confirm(app, tokenFrom(sent.at(-1)?.url ?? ""))).status).toBe(200);
    expect(repo.byEmail("b@example.invalid")).toMatchObject({ subscribed: true, unsubscribedAt: null });
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

  it("reports a failed send honestly (no false success), allows a retry and logs no provider text", async () => {
    const { app, repo, logs } = setup({ failSends: true });

    const response = await subscribe(app, "c@example.invalid");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      message: "The confirmation email could not be sent; nothing was changed, please retry later",
      code: "CONFIRMATION_EMAIL_NOT_SENT",
      retryAfterSeconds: 60,
    });
    expect(repo.byEmail("c@example.invalid")).toMatchObject({
      subscribed: false,
      confirmationSentAt: null,
      confirmationNonce: null,
    });
    expect(logs.raw()).toContain("marketing confirmation email not sent");
    expect(logs.raw()).toContain("provider_rejected");
    expect(logs.raw()).not.toContain("c@example.invalid");
  });

  it("429 without Retry-After: the resend limit stays; an immediate repeat does not call the provider", async () => {
    const { app, repo, sent, attempts, setOutcome, advance, logs } = setup();
    setOutcome({ kind: "rate_limited", retryAfterMs: null });
    expect((await subscribe(app, "r@example.invalid")).status).toBe(503);
    // No email, so no confirmation is pending; the limit is kept.
    expect(repo.byEmail("r@example.invalid")).toMatchObject({ confirmationNonce: null, confirmationSource: null });
    expect(repo.byEmail("r@example.invalid")?.confirmationSentAt).toBeInstanceOf(Date);
    expect(logs.raw()).toContain("rate_limited");

    setOutcome({ kind: "accepted" });
    expect((await subscribe(app, "r@example.invalid")).status).toBe(202); // neutral, unchanged contract
    advance(CONFIRMATION_COOLDOWN_MS - 1);
    expect((await subscribe(app, "r@example.invalid")).status).toBe(202);
    expect(attempts).toHaveLength(1); // no provider call during the block

    advance(2);
    expect((await subscribe(app, "r@example.invalid")).status).toBe(202);
    expect(attempts).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect(attempts[1]).not.toBe(attempts[0]); // a new legitimate attempt: new key
  });

  it("429 with Retry-After: no provider call before it, a retry is allowed once it has passed", async () => {
    const { app, attempts, setOutcome, advance } = setup();
    setOutcome({ kind: "rate_limited", retryAfterMs: 120_000 });
    expect((await subscribe(app, "ra@example.invalid")).status).toBe(503);
    setOutcome({ kind: "accepted" });
    advance(119_999);
    await subscribe(app, "ra@example.invalid");
    expect(attempts).toHaveLength(1);
    advance(2);
    await subscribe(app, "ra@example.invalid");
    expect(attempts).toHaveLength(2);
  });

  it("429 with a Retry-After longer than the cooldown: blocked for the provider's time, not just the cooldown", async () => {
    const { app, attempts, setOutcome, advance } = setup();
    setOutcome({ kind: "rate_limited", retryAfterMs: 30 * 60_000 });
    await subscribe(app, "long@example.invalid");
    setOutcome({ kind: "accepted" });
    advance(CONFIRMATION_COOLDOWN_MS + 1);
    await subscribe(app, "long@example.invalid");
    expect(attempts).toHaveLength(1);
    advance(30 * 60_000 - CONFIRMATION_COOLDOWN_MS);
    await subscribe(app, "long@example.invalid");
    expect(attempts).toHaveLength(2);
  });

  it("a Retry-After that is not valid (absent, zero, above 24 h) falls back to the usual cooldown", () => {
    expect(rateLimitBlockMs(null)).toBe(CONFIRMATION_COOLDOWN_MS);
    expect(rateLimitBlockMs(0)).toBe(CONFIRMATION_COOLDOWN_MS);
    expect(rateLimitBlockMs(48 * 3_600_000)).toBe(CONFIRMATION_COOLDOWN_MS);
    expect(rateLimitBlockMs(90_000)).toBe(90_000);
  });

  it("sign-up checkbox after a 429: blocked until the limit ends, then possible again (only that case)", async () => {
    const { service, attempts, setOutcome, advance } = setup();
    const SIGNUP: ConsentRequest = { source: "signup_checkbox", textVersion: MARKETING_CONSENT_TEXT_VERSION };
    setOutcome({ kind: "rate_limited", retryAfterMs: 60_000 });
    expect(await service.requestSubscription("s@example.invalid", SIGNUP, "signup")).toBe("delivery_failed");
    setOutcome({ kind: "accepted" });
    expect(await service.requestSubscription("s@example.invalid", SIGNUP, "signup")).toBe("no_action");
    advance(60_001);
    expect(await service.requestSubscription("s@example.invalid", SIGNUP, "signup")).toBe("confirmation_sent");
    // An email that was actually sent is never repeated by the sign-up checkbox.
    advance(CONFIRMATION_COOLDOWN_MS + 1);
    expect(await service.requestSubscription("s@example.invalid", SIGNUP, "signup")).toBe("no_action");
    expect(attempts).toHaveLength(2);
  });

  it("unknown outcome (timeout, 5xx): the claim and its cooldown stay, so a repeat cannot send a second email", async () => {
    const { app, repo, attempts, setOutcome, advance, logs } = setup();
    setOutcome({ kind: "uncertain", code: "timeout" });
    const first = await subscribe(app, "t@example.invalid");
    expect(first.status).toBe(202); // neutral answer; the email may have been accepted
    expect(repo.byEmail("t@example.invalid")?.confirmationNonce).not.toBeNull();
    expect(logs.raw()).toContain("outcome unknown");

    setOutcome({ kind: "accepted" });
    await subscribe(app, "t@example.invalid");
    expect(attempts).toHaveLength(1); // inside the cooldown: no second send

    advance(CONFIRMATION_COOLDOWN_MS + 1);
    await subscribe(app, "t@example.invalid");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).not.toBe(attempts[0]); // after the cooldown: a legitimate new email, new key
  });

  it("idempotency keys: stable for one operation, different for a re-subscription after unsubscribing", async () => {
    const { app, sent } = setup();
    await subscribe(app, "k@example.invalid");
    await confirm(app, tokenFrom(sent[0]?.url ?? ""));
    await unsubscribe(app, tokenFrom(sent[1]?.url ?? ""));
    await subscribe(app, "k@example.invalid");
    await confirm(app, tokenFrom(sent[2]?.url ?? ""));

    const keys = sent.map((mail) => mail.key);
    expect(keys.every((key) => /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key))).toBe(true);
    expect(new Set(keys).size).toBe(4); // request, confirmed, new request, new confirmed: all distinct
    expect(sent.map((mail) => mail.kind)).toEqual(["confirm", "confirmed", "confirm", "confirmed"]);
  });

  it("validates input strictly", async () => {
    const { app } = setup();
    for (const body of [
      { email: "nope", consentTextVersion: MARKETING_CONSENT_TEXT_VERSION },
      { email: "a@example.invalid", consentTextVersion: MARKETING_CONSENT_TEXT_VERSION, subscribed: true },
      { email: "a@example.invalid" },
      {},
    ]) {
      expect((await request(app).post("/api/marketing/subscriptions").send(body)).status).toBe(400);
    }
  });

  it("refuses an outdated consent text and records nothing", async () => {
    const { app, repo, sent } = setup();

    const response = await subscribe(app, "old@example.invalid", "2020-01-01.fr.0");

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      message: "The consent text shown is outdated; reload and show the current one",
      code: "CONSENT_TEXT_OUTDATED",
      currentConsentTextVersion: MARKETING_CONSENT_TEXT_VERSION,
    });
    expect(repo.byEmail("old@example.invalid")).toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
