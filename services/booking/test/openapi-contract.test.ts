import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app.js";
import { MARKETING_CONSENT_TEXT_VERSION } from "../src/modules/marketing/consent.js";
import { createMarketingRouter } from "../src/modules/marketing/marketing.routes.js";
import {
  errorSchema,
  liveSchema,
  ownSubscriptionRequestedSchema,
  profileViewSchema,
  readySchema,
  syncResponseSchema,
} from "../src/openapi/schemas.js";
import { identity } from "./helpers/fake-identity.js";
import { createCapturingLogger } from "./helpers/logs.js";
import { createProfileTestApp } from "./helpers/profile-app.js";

// Contract: real responses of the profile, marketing and health routes parse
// with the documented response schemas (strict: no undocumented fields).
// Bookings, catalogue and administration: test/integration/openapi-contract.test.ts.

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const codeMessage = (code: string) => z.strictObject({ code: z.literal(code), message: z.string() });

describe("documented responses (profile, marketing, health)", () => {
  it("profile: sync (with the sign-up checkbox), read, update, unsubscribe, errors", async () => {
    const t = createProfileTestApp();
    t.identities.issue("token-anna", identity({ uid: "uid-anna", email: "anna@example.invalid" }));

    const synced = await request(t.app)
      .post("/api/me/sync")
      .set(bearer("token-anna"))
      .send({ marketingOptIn: true, marketingConsentTextVersion: MARKETING_CONSENT_TEXT_VERSION })
      .expect(200);
    expect(syncResponseSchema.parse(synced.body).marketingOptIn?.outcome).toBe("confirmation_sent");
    profileViewSchema.parse((await request(t.app).get("/api/me").set(bearer("token-anna")).expect(200)).body);
    profileViewSchema.parse(
      (await request(t.app).patch("/api/me").set(bearer("token-anna")).send({ name: "Anna Example", phone: "+33612345678" }).expect(200)).body,
    );
    profileViewSchema.parse((await request(t.app).delete("/api/me/marketing/subscription").set(bearer("token-anna")).expect(200)).body);

    // Errors keep the documented shape.
    errorSchema.parse((await request(t.app).get("/api/me").expect(401)).body);
    errorSchema.parse((await request(t.app).patch("/api/me").set(bearer("token-anna")).send({ email: "x@example.invalid" }).expect(400)).body);
    t.identities.issue("token-new", identity({ uid: "uid-new", email: "new@example.invalid" }));
    errorSchema.parse((await request(t.app).get("/api/me").set(bearer("token-new")).expect(404)).body);
  });

  it("own subscription: requested, cooldown with retryAfterSeconds, outdated text, guests refused", async () => {
    const t = createProfileTestApp();
    t.identities.issue("token-anna", identity({ uid: "uid-anna", email: "anna@example.invalid" }));
    await request(t.app).post("/api/me/sync").set(bearer("token-anna")).expect(200);
    const body = { consentTextVersion: MARKETING_CONSENT_TEXT_VERSION };

    expect(ownSubscriptionRequestedSchema.parse((await request(t.app).post("/api/me/marketing/subscription").set(bearer("token-anna")).send(body).expect(202)).body)).toEqual({
      outcome: "confirmation_sent",
    });
    const again = ownSubscriptionRequestedSchema.parse(
      (await request(t.app).post("/api/me/marketing/subscription").set(bearer("token-anna")).send(body).expect(202)).body,
    );
    expect(again.outcome).toBe("no_action");
    expect(again.retryAfterSeconds).toBeGreaterThan(0);

    const outdated = errorSchema.parse(
      (await request(t.app).post("/api/me/marketing/subscription").set(bearer("token-anna")).send({ consentTextVersion: "old" }).expect(409)).body,
    );
    expect(outdated.currentConsentTextVersion).toBe(MARKETING_CONSENT_TEXT_VERSION);

    t.identities.issue("token-guest", identity({ uid: "uid-guest", isAnonymous: true, signInProvider: "anonymous", email: undefined, emailVerified: false }));
    await request(t.app).post("/api/me/sync").set(bearer("token-guest")).expect(200);
    errorSchema.parse((await request(t.app).post("/api/me/marketing/subscription").set(bearer("token-guest")).send(body).expect(403)).body);
  });

  it("public marketing routes: subscribe, confirm, unsubscribe, invalid link", async () => {
    const t = createProfileTestApp();
    const api = Router();
    if (t.marketingService === undefined) {
      throw new Error("marketing is enabled in this helper");
    }
    api.use("/marketing", createMarketingRouter(t.marketingService));
    const app = createApp({
      logger: createCapturingLogger().logger,
      isShuttingDown: () => false,
      probeReadiness: () => Promise.resolve("ready"),
      appVersion: "0123456789abcdef0123456789abcdef01234567",
      corsOrigin: undefined,
      apiRouter: api,
    });

    codeMessage("SUBSCRIPTION_REQUESTED").parse(
      (await request(app).post("/api/marketing/subscriptions").send({ email: "form@example.invalid", consentTextVersion: MARKETING_CONSENT_TEXT_VERSION }).expect(202)).body,
    );
    const link = t.sent.find((mail) => mail.kind === "confirm")?.url ?? "";
    const token = new URL(link).searchParams.get("token") ?? "";
    z.strictObject({ code: z.enum(["SUBSCRIBED", "ALREADY_SUBSCRIBED"]), message: z.string() }).parse(
      (await request(app).post("/api/marketing/subscriptions/confirm").send({ token }).expect(200)).body,
    );
    const unsubscribeLink = t.sent.find((mail) => mail.kind === "confirmed")?.url ?? "";
    const unsubscribeToken = new URL(unsubscribeLink).searchParams.get("token") ?? "";
    codeMessage("UNSUBSCRIBED").parse((await request(app).post("/api/marketing/subscriptions/unsubscribe").send({ token: unsubscribeToken }).expect(200)).body);
    errorSchema.parse((await request(app).post("/api/marketing/subscriptions/confirm").send({ token: "bad" }).expect(400)).body);

    liveSchema.parse((await request(app).get("/health/live").expect(200)).body);
    readySchema.parse((await request(app).get("/health/ready").expect(200)).body);
  });
});
