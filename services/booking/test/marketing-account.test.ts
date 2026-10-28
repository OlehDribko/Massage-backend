import request from "supertest";
import { describe, expect, it } from "vitest";
import { MARKETING_CONSENT_TEXT_VERSION } from "../src/modules/marketing/consent.js";
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
  const confirm = async (index: number) => {
    const service = context.marketingService;
    if (service === undefined) {
      throw new Error("marketing disabled");
    }
    return service.confirm(tokenFrom(context.sent[index]?.url));
  };
  return { ...context, confirm };
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
    expect(explicit.body).toMatchObject({ code: "CONFIRMATION_EMAIL_NOT_SENT" });
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
