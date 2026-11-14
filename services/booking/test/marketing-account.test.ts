import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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
  // Another email + password account, not verified yet, and the same account after verification.
  context.identities.issue("pending", identity({ uid: "uid-pending", email: "p@example.invalid", emailVerified: false, issuedAt: new Date("2026-10-28T10:00:00Z") }));
  context.identities.issue("pending-verified", identity({ uid: "uid-pending", email: "p@example.invalid", emailVerified: true, issuedAt: new Date("2026-10-28T10:05:00Z") }));
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

describe("test recipient allowlist in the account", () => {
  it("sign-up checkbox and the subscribe button: no email and no success for an address outside the list", async () => {
    const { app, sent, marketing } = setup({ marketingRecipientAllowlist: new Set(["new@example.invalid"]) });
    const synced = await sync(app, "google", OPT_IN);
    expect(synced.status).toBe(200);
    expect(synced.body).toMatchObject({ marketingOptIn: { outcome: "test_recipient_not_allowed" } });

    const button = await request(app)
      .post("/api/me/marketing/subscription")
      .set(bearer("google"))
      .send({ consentTextVersion: MARKETING_CONSENT_TEXT_VERSION });
    expect(button.status).toBe(403);
    expect(button.body).toMatchObject({ code: "TEST_RECIPIENT_NOT_ALLOWED" });
    expect(sent).toHaveLength(0);
    expect(marketing.all()).toHaveLength(0);

    // An address on the list works as usual.
    expect((await sync(app, "signup", OPT_IN)).body).toMatchObject({ marketingOptIn: { outcome: "confirmation_sent" } });
    expect(sent).toHaveLength(1);
  });
});

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

  it("verified email (Google): the checkbox subscribes at once, with a welcome email and no confirmation link", async () => {
    const { app, sent } = setup();

    const response = await sync(app, "google", OPT_IN);

    expect(response.body).toMatchObject({
      profile: { signInProvider: "google.com", emailVerified: true },
      marketing: { subscribed: true, pendingConfirmation: false, consentSource: "signup_checkbox", consentTextVersion: MARKETING_CONSENT_TEXT_VERSION },
      marketingOptIn: { outcome: "subscribed", welcomeEmail: "sent" },
    });
    expect(sent.map((mail) => [mail.kind, mail.email])).toEqual([["confirmed", "g@example.invalid"]]);
    expect(sent[0]?.url).toMatch(/^https:\/\/front\.example\.invalid\/unsubscribe\?token=/);
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

  it("repeated and parallel syncs with the checkbox subscribe once and send one email only", async () => {
    const { app, sent } = setup();

    const parallel = await Promise.all(Array.from({ length: 10 }, () => sync(app, "google", OPT_IN)));
    for (let i = 0; i < 5; i += 1) {
      await sync(app, "google", OPT_IN);
    }

    expect(parallel.every((response) => response.status === 200)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("never unsubscribes a subscriber through an absent or false checkbox", async () => {
    const { app } = setup();
    await sync(app, "google", OPT_IN);

    await sync(app, "google");
    await sync(app, "google", { marketingOptIn: false });

    expect((await sync(app, "google")).body).toMatchObject({ marketing: { subscribed: true } });
  });

  it("after unsubscribing, the checkbox never re-subscribes; only an explicit request does (a new consent cycle)", async () => {
    const { app, sent, marketing, advance } = setup();
    await sync(app, "google", OPT_IN);
    const firstConsent = marketing.byEmail("g@example.invalid")?.consentGivenAt;

    const unsubscribed = await request(app).delete("/api/me/marketing/subscription").set(bearer("google"));
    expect(unsubscribed.status).toBe(200);
    expect(unsubscribed.body).toMatchObject({ marketing: { subscribed: false, consentSource: "signup_checkbox" } });
    expect(unsubscribed.body).not.toMatchObject({ marketing: { unsubscribedAt: null } });

    // Login, a plain sync or a repeated sign-up checkbox never re-subscribes.
    expect((await sync(app, "google")).body).toMatchObject({ marketing: { subscribed: false } });
    const resync = await sync(app, "google", OPT_IN);
    expect(resync.body).toMatchObject({ marketing: { subscribed: false }, marketingOptIn: { outcome: "no_action" } });
    expect(sent).toHaveLength(1);

    advance(60_000);
    const explicit = await request(app)
      .post("/api/me/marketing/subscription")
      .set(bearer("google"))
      .send({ consentTextVersion: MARKETING_CONSENT_TEXT_VERSION });
    expect(explicit.status).toBe(200);
    expect(explicit.body).toMatchObject({
      outcome: "subscribed",
      welcomeEmail: "sent",
      marketing: { subscribed: true, consentSource: "account_request", unsubscribedAt: null },
    });
    expect(sent).toHaveLength(2);
    expect(marketing.byEmail("g@example.invalid")?.consentGivenAt?.getTime()).toBeGreaterThan(firstConsent?.getTime() ?? Infinity);
  });

  it("unverified email: a failed confirmation email does not break the sign-up and is reported honestly", async () => {
    const { app, marketing, profiles, logs } = setup({ failMarketingSends: true });

    const response = await sync(app, "pending", OPT_IN);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      profile: { email: "p@example.invalid" },
      marketing: null,
      marketingOptIn: { outcome: "delivery_failed" },
    });
    expect(profiles.all()).toHaveLength(1);
    expect(marketing.byEmail("p@example.invalid")).toMatchObject({ subscribed: false, confirmationSentAt: null });
    expect(logs.raw()).not.toContain("PROVIDER_SENTINEL");

    const explicit = await request(app)
      .post("/api/me/marketing/subscription")
      .set(bearer("pending"))
      .send({ consentTextVersion: MARKETING_CONSENT_TEXT_VERSION });
    expect(explicit.status).toBe(503);
    // Refused by the provider: nothing is blocked, the default hint.
    expect(explicit.body).toMatchObject({ code: "CONFIRMATION_EMAIL_NOT_SENT", retryAfterSeconds: 60 });
    expect(explicit.headers["retry-after"]).toBe("60");
  });

  it("explicit request after a provider 429: the hint is the stored block; a repeat before it does not call the provider", async () => {
    const { app, setMarketingRateLimited, sendAttempts, advance } = setup();
    await sync(app, "pending");
    setMarketingRateLimited(90_000);
    const body = { consentTextVersion: MARKETING_CONSENT_TEXT_VERSION };

    const refused = await request(app).post("/api/me/marketing/subscription").set(bearer("pending")).send(body);
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
    const early = await request(app).post("/api/me/marketing/subscription").set(bearer("pending")).send(body);
    expect(early.status).toBe(202);
    expect(early.body).toEqual({ outcome: "no_action", retryAfterSeconds: 60 });
    expect(sendAttempts()).toBe(1);

    advance(60_001);
    const later = await request(app).post("/api/me/marketing/subscription").set(bearer("pending")).send(body);
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

describe("recovering an unfinished subscription (explicit resend, unverified email)", () => {
  const resend = (app: Parameters<typeof request>[0], token: string) =>
    request(app)
      .post("/api/me/marketing/subscription")
      .set(bearer(token))
      .send({ consentTextVersion: MARKETING_CONSENT_TEXT_VERSION });

  it("lost email: syncs never resend; the explicit resend is rate-limited and replaces the old link", async () => {
    const { app, sent, confirm, advance } = setup();
    await sync(app, "pending", OPT_IN);

    for (let i = 0; i < 3; i += 1) {
      expect((await sync(app, "pending", OPT_IN)).body).toMatchObject({ marketingOptIn: { outcome: "no_action" } });
    }
    const tooSoon = await resend(app, "pending");
    expect(tooSoon.status).toBe(202);
    expect(tooSoon.body).toEqual({ outcome: "no_action", retryAfterSeconds: CONFIRMATION_COOLDOWN_MS / 1000 });
    advance(CONFIRMATION_COOLDOWN_MS / 2);
    expect((await resend(app, "pending")).body).toEqual({ outcome: "no_action", retryAfterSeconds: CONFIRMATION_COOLDOWN_MS / 2000 });
    expect(sent).toHaveLength(1);

    advance(CONFIRMATION_COOLDOWN_MS / 2 + 1);
    expect((await resend(app, "pending")).body).toEqual({ outcome: "confirmation_sent" });
    expect(sent).toHaveLength(2);
    expect((await resend(app, "pending")).body).toMatchObject({ outcome: "no_action" });

    // The lost (first) link no longer works; the new one does.
    await expect(confirm(0)).rejects.toMatchObject({ statusCode: 400 });
    expect(await confirm(1)).toBe("subscribed");
    expect((await resend(app, "pending")).body).toEqual({ outcome: "no_action" });
  });

  it("expired link: rejected, nothing changes, an explicit resend issues a working link", async () => {
    const { app, marketing, sent, confirm, confirmToken, advance } = setup();
    await sync(app, "pending", OPT_IN);
    const row = marketing.byEmail("p@example.invalid");
    const expired = jwt.sign(
      { userId: row?.id, purpose: "marketing_confirm", nonce: row?.confirmationNonce },
      "profile-test-secret-0123456789abcdef",
      { issuer: "massage-backend", expiresIn: -10 },
    );
    advance(7 * 24 * 60 * 60 * 1000);

    await expect(confirmToken(expired)).rejects.toMatchObject({ statusCode: 400 });
    expect((await sync(app, "pending-verified")).body).toMatchObject({ marketing: { subscribed: false, pendingConfirmation: true } });

    expect((await resend(app, "pending")).body).toEqual({ outcome: "confirmation_sent" });
    expect(await confirm(sent.length - 1)).toBe("subscribed");
    expect((await sync(app, "pending-verified")).body).toMatchObject({
      marketing: { subscribed: true, consentSource: "account_request" },
    });
  });

  it("failed delivery: no cooldown is charged; a retry sends once and later syncs send nothing", async () => {
    const { app, sent, confirm, setMarketingSendsFailing } = setup({ failMarketingSends: true });
    expect((await sync(app, "pending", OPT_IN)).body).toMatchObject({ marketingOptIn: { outcome: "delivery_failed" } });
    const failed = await resend(app, "pending");
    expect(failed.status).toBe(503);
    expect(failed.headers["retry-after"]).toBe("60");

    setMarketingSendsFailing(false);
    expect((await resend(app, "pending")).body).toEqual({ outcome: "confirmation_sent" });
    expect((await sync(app, "pending", OPT_IN)).body).toMatchObject({ marketingOptIn: { outcome: "no_action" } });
    expect(sent).toHaveLength(1);
    expect(await confirm(0)).toBe("subscribed");
  });

  it("failed delivery at sign-up: the same checkbox sent again by a sync retry sends once", async () => {
    const { app, sent, setMarketingSendsFailing } = setup({ failMarketingSends: true });
    await sync(app, "pending", OPT_IN);
    setMarketingSendsFailing(false);

    expect((await sync(app, "pending", OPT_IN)).body).toMatchObject({ marketingOptIn: { outcome: "confirmation_sent" } });
    expect((await sync(app, "pending", OPT_IN)).body).toMatchObject({ marketingOptIn: { outcome: "no_action" } });
    expect(sent).toHaveLength(1);
  });
});

describe("marketingAvailable: availability of the feature, not the user's subscription", () => {
  it("true on a server with marketing, false without; the same for guests, unverified and verified users", async () => {
    const on = setup();
    const off = setup({ marketingEnabled: false });
    for (const token of ["guest", "signup", "google"]) {
      expect((await sync(on.app, token)).body, token).toMatchObject({ marketingAvailable: true });
      expect((await sync(off.app, token)).body, token).toMatchObject({ marketingAvailable: false });
      expect((await request(on.app).get("/api/me").set(bearer(token))).body, token).toMatchObject({ marketingAvailable: true });
    }
    // Not subscribed and available: nothing about a subscription follows from the flag.
    expect((await sync(on.app, "google")).body).toMatchObject({ marketingAvailable: true, marketing: { subscribed: false, pendingConfirmation: false } });
  });

  it("an unverified email: the checkbox starts double opt-in, but the status stays hidden until the email is verified", async () => {
    const { app, sent, confirm } = setup();
    const first = await sync(app, "signup", OPT_IN);
    expect(first.body).toMatchObject({ marketingAvailable: true, marketing: null, marketingOptIn: { outcome: "confirmation_sent" } });
    expect(sent).toHaveLength(1);

    // Still unverified in Firebase: confirming the emailed link subscribes the address, the profile still hides the status.
    await confirm(0);
    expect((await request(app).get("/api/me").set(bearer("signup"))).body).toMatchObject({ marketing: null });
    // Verified: the status is shown.
    expect((await sync(app, "signup-verified")).body).toMatchObject({ marketing: { subscribed: true, pendingConfirmation: false } });
  });
});

describe("direct subscription of a verified, registered user's own address (POST /api/me/marketing/subscription)", () => {
  const subscribe = (app: Parameters<typeof request>[0], token: string, body: object = { consentTextVersion: MARKETING_CONSENT_TEXT_VERSION }) =>
    request(app).post("/api/me/marketing/subscription").set(bearer(token)).send(body);

  it("active at once (200 subscribed) with the consent recorded and one welcome email; a repeat is already_subscribed, no new email", async () => {
    const { app, sent, marketing } = setup();
    const first = await subscribe(app, "google");
    expect(first.status).toBe(200);
    expect(Object.keys(z.object({}).passthrough().parse(first.body)).sort()).toEqual(["marketing", "outcome", "welcomeEmail"]);
    expect(first.body).toMatchObject({
      outcome: "subscribed",
      welcomeEmail: "sent",
      marketing: { subscribed: true, pendingConfirmation: false, consentSource: "account_request", consentTextVersion: MARKETING_CONSENT_TEXT_VERSION },
    });
    expect(marketing.byEmail("g@example.invalid")).toMatchObject({ subscribed: true, confirmationNonce: null });
    expect(sent.map((mail) => mail.kind)).toEqual(["confirmed"]);

    const again = await subscribe(app, "google");
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ outcome: "already_subscribed", marketing: { subscribed: true } });
    expect(again.body).not.toHaveProperty("welcomeEmail");
    expect(sent).toHaveLength(1);
  });

  it("parallel requests: one activation, one welcome email", async () => {
    const { app, sent, marketing } = setup();
    const responses = await Promise.all(Array.from({ length: 10 }, () => subscribe(app, "google")));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const outcomes = responses.map((response) => z.object({ outcome: z.string() }).parse(response.body).outcome);
    expect(outcomes.filter((outcome) => outcome === "subscribed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "already_subscribed")).toHaveLength(9);
    expect(marketing.all()).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("pending → active: a waiting confirmation becomes the active subscription and its old link stops working", async () => {
    const { app, sent, confirm, marketing } = setup();
    await sync(app, "pending", OPT_IN);
    expect(sent.map((mail) => mail.kind)).toEqual(["confirm"]);

    const direct = await subscribe(app, "pending-verified");
    expect(direct.body).toMatchObject({ outcome: "subscribed", marketing: { subscribed: true, pendingConfirmation: false } });
    expect(marketing.byEmail("p@example.invalid")).toMatchObject({ confirmationNonce: null, consentSource: "account_request" });
    // The old link changes nothing: no second welcome email, and after unsubscribing it cannot re-subscribe.
    expect(await confirm(0)).toBe("already_subscribed");
    expect(sent.map((mail) => mail.kind)).toEqual(["confirm", "confirmed"]);
    await request(app).delete("/api/me/marketing/subscription").set(bearer("pending-verified")).expect(200);
    await expect(confirm(0)).rejects.toMatchObject({ statusCode: 400 });
    expect(marketing.byEmail("p@example.invalid")?.subscribed).toBe(false);
  });

  it("only the caller's own verified address: no address can be given; unverified keeps double opt-in", async () => {
    const { app, sent, marketing } = setup();
    for (const body of [
      { consentTextVersion: MARKETING_CONSENT_TEXT_VERSION, email: "other@example.invalid" },
      { consentTextVersion: MARKETING_CONSENT_TEXT_VERSION, emailVerified: true },
    ]) {
      expect((await subscribe(app, "pending", body)).status).toBe(400);
    }
    expect(marketing.all()).toHaveLength(0);

    const unverified = await subscribe(app, "pending");
    expect(unverified.status).toBe(202);
    expect(unverified.body).toEqual({ outcome: "confirmation_sent" });
    expect(marketing.byEmail("p@example.invalid")?.subscribed).toBe(false);
    expect(sent.map((mail) => [mail.kind, mail.email])).toEqual([["confirm", "p@example.invalid"]]);
  });

  it("anonymous, invalid, expired and revoked tokens never activate anything", async () => {
    const { app, identities, marketing, sent } = setup();
    identities.fail("revoked-token", "revoked");
    identities.fail("expired-token", "expired");
    expect((await subscribe(app, "guest")).status).toBe(403);
    for (const token of ["not-a-token", "revoked-token", "expired-token"]) {
      expect((await subscribe(app, token)).status, token).toBe(401);
      expect((await sync(app, token, OPT_IN)).status, token).toBe(401);
    }
    expect(marketing.all()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("a failed welcome email keeps the active subscription and is reported as such, not as a failed subscription", async () => {
    const { app, marketing, sent } = setup({ failMarketingSends: true });
    const response = await subscribe(app, "google");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: "subscribed", welcomeEmail: "not_sent", marketing: { subscribed: true } });
    expect(marketing.byEmail("g@example.invalid")?.subscribed).toBe(true);
    expect(sent).toHaveLength(0);

    const checkbox = await sync(setup({ failMarketingSends: true }).app, "google", OPT_IN);
    expect(checkbox.body).toMatchObject({ marketingOptIn: { outcome: "subscribed", welcomeEmail: "not_sent" }, marketing: { subscribed: true } });
  });

  it("unsubscribe, then a new explicit request: a new activation with a new welcome email", async () => {
    const { app, sent } = setup();
    await subscribe(app, "google");
    await request(app).delete("/api/me/marketing/subscription").set(bearer("google")).expect(200);
    const again = await subscribe(app, "google");
    expect(again.body).toMatchObject({ outcome: "subscribed", welcomeEmail: "sent" });
    expect(sent.map((mail) => mail.kind)).toEqual(["confirmed", "confirmed"]);
  });

  it("test allowlist and disabled marketing: nothing is activated", async () => {
    const limited = setup({ marketingRecipientAllowlist: new Set(["new@example.invalid"]) });
    expect((await subscribe(limited.app, "google")).body).toMatchObject({ code: "TEST_RECIPIENT_NOT_ALLOWED" });
    expect(limited.marketing.all()).toHaveLength(0);

    const off = setup({ marketingEnabled: false });
    expect((await subscribe(off.app, "google")).status).toBe(404);
    expect((await sync(off.app, "google", OPT_IN)).body).toMatchObject({ marketingOptIn: { outcome: "unavailable" }, marketing: { subscribed: false } });
  });
});

describe("diagnostics of a failed opt-in at sign-up", () => {
  it("the profile is still synced; the error record carries the request id of the response", async () => {
    const { app, marketing, logs } = setup();
    marketing.repository.ensureExists = () => Promise.reject(new Error("SENTINEL_STORE g@example.invalid"));

    const synced = await sync(app, "google", OPT_IN);

    expect(synced.status).toBe(200);
    expect(synced.body).toMatchObject({ marketingOptIn: { outcome: "failed" } });
    const entry = logs.entries().find((logged) => logged.msg === "marketing opt-in during profile sync failed");
    expect(entry).toMatchObject({ level: "error", requestId: synced.get("X-Request-Id") });
    expect(logs.raw()).not.toMatch(/SENTINEL_STORE|g@example\.invalid/);
  });
});
