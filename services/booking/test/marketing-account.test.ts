import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { MARKETING_CONSENT_TEXT_VERSION } from "../src/modules/marketing/consent.js";
import { CONFIRMATION_COOLDOWN_MS } from "../src/modules/marketing/marketing.service.js";
import { identity } from "./helpers/fake-identity.js";
import { createProfileTestApp } from "./helpers/profile-app.js";

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const OPT_IN = { marketingOptIn: true, marketingConsentTextVersion: MARKETING_CONSENT_TEXT_VERSION };
const tokenFrom = (url: string | undefined) => new URL(url ?? "http://x/").searchParams.get("token") ?? "";

const setup = (options: Parameters<typeof createProfileTestApp>[0] = {}) => {
  const context = createProfileTestApp(options);
  // Email + password sign-up: email not verified yet.
  context.identities.issue("signup", identity({ uid: "uid-new", email: "new@example.invalid", emailVerified: false, issuedAt: new Date("2026-10-28T10:00:00Z") }));
  context.identities.issue("signup-verified", identity({ uid: "uid-new", email: "new@example.invalid", emailVerified: true, issuedAt: new Date("2026-10-28T10:05:00Z") }));
  // Google sign-in: email verified by Google.
  context.identities.issue("google", identity({ uid: "uid-google", email: "g@example.invalid", emailVerified: true, signInProvider: "google.com" }));
  context.identities.issue("guest", identity({ uid: "uid-guest", isAnonymous: true, signInProvider: "anonymous", email: undefined, emailVerified: false }));
  const confirmToken = async (token: string) => {
    const service = context.marketingService;
    if (service === undefined) {
      throw new Error("marketing disabled");
    }
    return service.confirm(token);
  };
  const confirm = (index: number) => confirmToken(tokenFrom(context.sent[index]?.url));
  return { ...context, confirm, confirmToken };
};

const sync = (app: Parameters<typeof request>[0], token: string, body?: object) =>
  body === undefined
    ? request(app).post("/api/me/sync").set(bearer(token))
    : request(app).post("/api/me/sync").set(bearer(token)).send(body);

describe("sign-up checkbox (marketingOptIn in POST /api/me/sync)", () => {
  it("email + password: checkbox starts double opt-in; status turns true only after confirmation", async () => {
    const { app, sent, marketing, confirm } = setup();

    const response = await sync(app, "signup", OPT_IN);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      profile: { email: "new@example.invalid", emailVerified: false },
      // Unverified email: the status of that address is not shown.
      marketing: null,
      marketingOptIn: { outcome: "confirmation_sent", currentConsentTextVersion: MARKETING_CONSENT_TEXT_VERSION },
    });
    expect(sent).toEqual([expect.objectContaining({ kind: "confirm", email: "new@example.invalid" })]);
    expect(marketing.byEmail("new@example.invalid")?.subscribed).toBe(false);

    // Firebase email verification is a separate action and grants nothing.
    const verified = await sync(app, "signup-verified");
    expect(verified.body).toMatchObject({
      marketing: { subscribed: false, pendingConfirmation: true, consentGivenAt: null },
    });

    expect(await confirm(0)).toBe("subscribed");
    const after = await request(app).get("/api/me").set(bearer("signup-verified"));
    expect(after.body).toMatchObject({
      marketing: {
        subscribed: true,
        pendingConfirmation: false,
        consentSource: "signup_checkbox",
        consentTextVersion: MARKETING_CONSENT_TEXT_VERSION,
        unsubscribedAt: null,
      },
    });
  });

  it("Google: same flow, status pending until the link is confirmed", async () => {
    const { app, sent, confirm } = setup();

    const response = await sync(app, "google", OPT_IN);

    expect(response.body).toMatchObject({
      profile: { signInProvider: "google.com", emailVerified: true },
      marketing: { subscribed: false, pendingConfirmation: true },
      marketingOptIn: { outcome: "confirmation_sent" },
    });
    expect(sent).toHaveLength(1);
    expect(await confirm(0)).toBe("subscribed");
    expect((await sync(app, "google")).body).toMatchObject({ marketing: { subscribed: true } });
  });

  it.each([
    ["absent", undefined],
    ["false", { marketingOptIn: false }],
    ["empty body", {}],
  ])("checkbox %s: no consent, no email, even with a verified email", async (_label, body) => {
    const { app, sent, marketing } = setup();

    const response = await sync(app, "google", body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      marketing: { subscribed: false, pendingConfirmation: false, consentGivenAt: null },
    });
    expect(response.body).not.toHaveProperty("marketingOptIn");
    expect(sent).toHaveLength(0);
    expect(marketing.all()).toHaveLength(0);
  });

  it("repeated and parallel syncs with the checkbox send one email only", async () => {
    const { app, sent } = setup();

    const parallel = await Promise.all(Array.from({ length: 10 }, () => sync(app, "google", OPT_IN)));
    for (let i = 0; i < 5; i += 1) {
      await sync(app, "google", OPT_IN);
    }

    expect(parallel.every((response) => response.status === 200)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("never unsubscribes a subscriber through an absent or false checkbox", async () => {
    const { app, confirm } = setup();
    await sync(app, "google", OPT_IN);
    await confirm(0);

    await sync(app, "google");
    await sync(app, "google", { marketingOptIn: false });

    expect((await sync(app, "google")).body).toMatchObject({ marketing: { subscribed: true } });
  });

  it("after unsubscribing, the checkbox never re-subscribes; only an explicit request does", async () => {
    const { app, sent, confirm } = setup();
    await sync(app, "google", OPT_IN);
    await confirm(0);

    const unsubscribed = await request(app).delete("/api/me/marketing/subscription").set(bearer("google"));
    expect(unsubscribed.status).toBe(200);
    expect(unsubscribed.body).toMatchObject({ marketing: { subscribed: false, consentSource: "signup_checkbox" } });
    expect(unsubscribed.body).not.toMatchObject({ marketing: { unsubscribedAt: null } });

    const resync = await sync(app, "google", OPT_IN);
    expect(resync.body).toMatchObject({ marketing: { subscribed: false }, marketingOptIn: { outcome: "no_action" } });
    expect(sent.filter((mail) => mail.kind === "confirm")).toHaveLength(1);

    const explicit = await request(app)
      .post("/api/me/marketing/subscription")
      .set(bearer("google"))
      .send({ consentTextVersion: MARKETING_CONSENT_TEXT_VERSION });
    expect(explicit.status).toBe(202);
    expect(explicit.body).toEqual({ outcome: "confirmation_sent" });
    expect((await sync(app, "google")).body).toMatchObject({ marketing: { subscribed: false, pendingConfirmation: true } });

    expect(await confirm(sent.length - 1)).toBe("subscribed");
    expect((await sync(app, "google")).body).toMatchObject({
      marketing: { subscribed: true, consentSource: "account_request", unsubscribedAt: null },
    });
  });

  it("a failed confirmation email does not break the sign-up and is reported honestly", async () => {
    const { app, marketing, profiles, logs } = setup({ failMarketingSends: true });

    const response = await sync(app, "google", OPT_IN);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      profile: { email: "g@example.invalid" },
      marketing: { subscribed: false, pendingConfirmation: false },
      marketingOptIn: { outcome: "delivery_failed" },
    });
    expect(profiles.all()).toHaveLength(1);
    expect(marketing.byEmail("g@example.invalid")).toMatchObject({ subscribed: false, confirmationSentAt: null });
    expect(logs.raw()).not.toContain("PROVIDER_SENTINEL");

    const explicit = await request(app)
      .post("/api/me/marketing/subscription")
      .set(bearer("google"))
      .send({ consentTextVersion: MARKETING_CONSENT_TEXT_VERSION });
    expect(explicit.status).toBe(503);
    // Refused by the provider: nothing is blocked, the default hint.
    expect(explicit.body).toMatchObject({ code: "CONFIRMATION_EMAIL_NOT_SENT", retryAfterSeconds: 60 });
    expect(explicit.headers["retry-after"]).toBe("60");
  });

  it("explicit request after a provider 429: the hint is the stored block; a repeat before it does not call the provider", async () => {
    const { app, setMarketingRateLimited, sendAttempts, advance } = setup();
    await sync(app, "google");
    setMarketingRateLimited(90_000);
    const body = { consentTextVersion: MARKETING_CONSENT_TEXT_VERSION };

    const refused = await request(app).post("/api/me/marketing/subscription").set(bearer("google")).send(body);
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({
      message: "The confirmation email could not be sent; retry in 90 seconds",
      code: "CONFIRMATION_EMAIL_NOT_SENT",
      retryAfterSeconds: 90,
    });
    expect(refused.headers["retry-after"]).toBe("90");
    expect(sendAttempts()).toBe(1);

    setMarketingRateLimited(undefined);
    advance(30_000);
    const early = await request(app).post("/api/me/marketing/subscription").set(bearer("google")).send(body);
    expect(early.status).toBe(202);
    expect(early.body).toEqual({ outcome: "no_action", retryAfterSeconds: 60 });
    expect(sendAttempts()).toBe(1);

    advance(60_001);
    const later = await request(app).post("/api/me/marketing/subscription").set(bearer("google")).send(body);
    expect(later.body).toEqual({ outcome: "confirmation_sent" });
    expect(sendAttempts()).toBe(2);
  });

  it("guests and disabled marketing: the sync succeeds with outcome unavailable", async () => {
    const guest = setup();
    const asGuest = await sync(guest.app, "guest", OPT_IN);
    expect(asGuest.status).toBe(200);
    expect(asGuest.body).toMatchObject({ marketing: null, marketingOptIn: { outcome: "unavailable" } });

    const disabled = setup({ marketingEnabled: false });
    const response = await sync(disabled.app, "google", OPT_IN);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ marketingOptIn: { outcome: "unavailable" } });
    expect(disabled.sent).toHaveLength(0);
  });

  it("an outdated consent text does not block the sign-up and records nothing", async () => {
    const { app, sent, marketing } = setup();

    const response = await sync(app, "google", { marketingOptIn: true, marketingConsentTextVersion: "2020-01-01.fr.0" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      marketingOptIn: { outcome: "consent_text_outdated", currentConsentTextVersion: MARKETING_CONSENT_TEXT_VERSION },
    });
    expect(sent).toHaveLength(0);
    expect(marketing.all()).toHaveLength(0);
  });

  it("requires the consent text version with the checkbox and rejects unknown fields", async () => {
    const { app } = setup();
    for (const body of [{ marketingOptIn: true }, { marketingOptIn: "yes" }, { subscribed: true }]) {
      const response = await sync(app, "google", body);
      expect(response.status).toBe(400);
    }
  });
});

describe("account actions", () => {
  it("unsubscribing requires a verified email", async () => {
    const { app } = setup();
    await sync(app, "signup");

    const response = await request(app).delete("/api/me/marketing/subscription").set(bearer("signup"));

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });

  it("guests cannot use the account subscription request", async () => {
    const { app } = setup();
    const response = await request(app)
      .post("/api/me/marketing/subscription")
      .set(bearer("guest"))
      .send({ consentTextVersion: MARKETING_CONSENT_TEXT_VERSION });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "REGISTERED_ACCOUNT_REQUIRED" });
  });

  it("a guest's form subscription survives losing the anonymous session and shows up after sign-up", async () => {
    const { app, identities, marketingService, sent, confirm } = setup();
    // Public form as a guest (the anonymous session is later lost).
    await marketingService?.requestSubscription(
      "later@example.invalid",
      { source: "subscription_form", textVersion: MARKETING_CONSENT_TEXT_VERSION },
      "explicit",
    );
    await confirm(0);
    expect(sent).toHaveLength(2);

    // A different Firebase identity later signs up with that (verified) email.
    identities.issue("later", identity({ uid: "uid-later", email: "later@example.invalid", emailVerified: true }));
    const response = await sync(app, "later");

    expect(response.body).toMatchObject({
      marketing: { subscribed: true, consentSource: "subscription_form" },
    });
  });
});

describe("recovering an unfinished subscription (explicit resend)", () => {
  const resend = (app: Parameters<typeof request>[0], token: string) =>
    request(app)
      .post("/api/me/marketing/subscription")
      .set(bearer(token))
      .send({ consentTextVersion: MARKETING_CONSENT_TEXT_VERSION });

  it("lost email: syncs never resend; the explicit resend is rate-limited and replaces the old link", async () => {
    const { app, sent, confirm, advance } = setup();
    await sync(app, "google", OPT_IN);

    for (let i = 0; i < 3; i += 1) {
      expect((await sync(app, "google", OPT_IN)).body).toMatchObject({ marketingOptIn: { outcome: "no_action" } });
    }
    const tooSoon = await resend(app, "google");
    expect(tooSoon.status).toBe(202);
    expect(tooSoon.body).toEqual({ outcome: "no_action", retryAfterSeconds: CONFIRMATION_COOLDOWN_MS / 1000 });
    advance(CONFIRMATION_COOLDOWN_MS / 2);
    expect((await resend(app, "google")).body).toEqual({ outcome: "no_action", retryAfterSeconds: CONFIRMATION_COOLDOWN_MS / 2000 });
    expect(sent).toHaveLength(1);

    advance(CONFIRMATION_COOLDOWN_MS / 2 + 1);
    expect((await resend(app, "google")).body).toEqual({ outcome: "confirmation_sent" });
    expect(sent).toHaveLength(2);
    expect((await resend(app, "google")).body).toMatchObject({ outcome: "no_action" });

    // The lost (first) link no longer works; the new one does.
    await expect(confirm(0)).rejects.toMatchObject({ statusCode: 400 });
    expect(await confirm(1)).toBe("subscribed");
    expect((await resend(app, "google")).body).toEqual({ outcome: "no_action" });
  });

  it("expired link: rejected, nothing changes, an explicit resend issues a working link", async () => {
    const { app, marketing, sent, confirm, confirmToken, advance } = setup();
    await sync(app, "google", OPT_IN);
    const row = marketing.byEmail("g@example.invalid");
    const expired = jwt.sign(
      { userId: row?.id, purpose: "marketing_confirm", nonce: row?.confirmationNonce },
      "profile-test-secret-0123456789abcdef",
      { issuer: "massage-backend", expiresIn: -10 },
    );
    advance(7 * 24 * 60 * 60 * 1000);

    await expect(confirmToken(expired)).rejects.toMatchObject({ statusCode: 400 });
    expect((await sync(app, "google")).body).toMatchObject({ marketing: { subscribed: false, pendingConfirmation: true } });

    expect((await resend(app, "google")).body).toEqual({ outcome: "confirmation_sent" });
    expect(await confirm(sent.length - 1)).toBe("subscribed");
    expect((await sync(app, "google")).body).toMatchObject({
      marketing: { subscribed: true, consentSource: "account_request" },
    });
  });

  it("failed delivery: no cooldown is charged; a retry sends once and later syncs send nothing", async () => {
    const { app, sent, confirm, setMarketingSendsFailing } = setup({ failMarketingSends: true });
    expect((await sync(app, "google", OPT_IN)).body).toMatchObject({ marketingOptIn: { outcome: "delivery_failed" } });
    const failed = await resend(app, "google");
    expect(failed.status).toBe(503);
    expect(failed.headers["retry-after"]).toBe("60");

    setMarketingSendsFailing(false);
    expect((await resend(app, "google")).body).toEqual({ outcome: "confirmation_sent" });
    expect((await sync(app, "google", OPT_IN)).body).toMatchObject({ marketingOptIn: { outcome: "no_action" } });
    expect(sent).toHaveLength(1);
    expect(await confirm(0)).toBe("subscribed");
  });

  it("failed delivery at sign-up: the same checkbox sent again by a sync retry sends once", async () => {
    const { app, sent, setMarketingSendsFailing } = setup({ failMarketingSends: true });
    await sync(app, "google", OPT_IN);
    setMarketingSendsFailing(false);

    expect((await sync(app, "google", OPT_IN)).body).toMatchObject({ marketingOptIn: { outcome: "confirmation_sent" } });
    expect((await sync(app, "google", OPT_IN)).body).toMatchObject({ marketingOptIn: { outcome: "no_action" } });
    expect(sent).toHaveLength(1);
  });
});
