import request from "supertest";
import { describe, expect, it } from "vitest";
import { identity } from "./helpers/fake-identity.js";
import { createProfileTestApp } from "./helpers/profile-app.js";

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const setup = () => {
  const context = createProfileTestApp();
  context.identities.issue("client", identity({ uid: "uid-client", name: "Marie Curie" }));
  context.identities.issue("guest", identity({
    uid: "uid-guest",
    isAnonymous: true,
    signInProvider: "anonymous",
    email: undefined,
    emailVerified: false,
  }));
  context.identities.issue("other", identity({ uid: "uid-other", email: "other@example.invalid" }));
  return context;
};

describe("/api/me", () => {
  it("creates the profile on sync, idempotently, with our own id", async () => {
    const { app, profiles } = setup();

    const first = await request(app).post("/api/me/sync").set(bearer("client"));
    const second = await request(app).post("/api/me/sync").set(bearer("client"));

    expect(first.status).toBe(200);
    expect(profiles.all()).toHaveLength(1);
    expect(second.body).toMatchObject({ profile: { id: profiles.all()[0]?.id } });
    expect(first.body).toMatchObject({
      profile: {
        role: "client",
        authState: "registered",
        name: "Marie Curie",
        email: "client@example.invalid",
        emailVerified: true,
        phone: null,
        signInProvider: "password",
      },
      bookingReadiness: { ready: false, blockers: ["phone_missing"] },
    });
    // Our id is not the Firebase UID, which is never returned.
    expect(first.body).toMatchObject({ profile: { id: profiles.all()[0]?.id } });
    expect(first.text).not.toContain("uid-client");
  });

  it("returns 404 PROFILE_NOT_FOUND before the first sync", async () => {
    const { app } = setup();

    for (const response of [
      await request(app).get("/api/me").set(bearer("client")),
      await request(app).patch("/api/me").set(bearer("client")).send({ name: "Marie" }),
    ]) {
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: "PROFILE_NOT_FOUND" });
    }
  });

  it("guests get a profile but are never booking-ready", async () => {
    const { app } = setup();

    const response = await request(app).post("/api/me/sync").set(bearer("guest"));

    expect(response.body).toMatchObject({
      profile: { authState: "anonymous", email: null, emailVerified: false, role: "client" },
      bookingReadiness: {
        ready: false,
        blockers: ["anonymous_session", "email_not_verified", "name_missing", "phone_missing"],
      },
    });
  });

  it("an unverified email blocks booking until a newer token says otherwise", async () => {
    const { app, identities } = setup();
    identities.issue("unverified", identity({ uid: "uid-u", emailVerified: false, name: "Ann", issuedAt: new Date("2026-10-27T10:00:00Z") }));
    identities.issue("verified", identity({ uid: "uid-u", emailVerified: true, issuedAt: new Date("2026-10-27T10:05:00Z") }));

    await request(app).post("/api/me/sync").set(bearer("unverified"));
    await request(app).patch("/api/me").set(bearer("unverified")).send({ phone: "+33 6 12 34 56 78" });
    const before = await request(app).get("/api/me").set(bearer("unverified"));
    expect(before.body).toMatchObject({ bookingReadiness: { ready: false, blockers: ["email_not_verified"] } });

    const after = await request(app).post("/api/me/sync").set(bearer("verified"));
    expect(after.body).toMatchObject({ bookingReadiness: { ready: true, blockers: [] } });

    // A request still carrying the older token does not roll verification back.
    const stale = await request(app).post("/api/me/sync").set(bearer("unverified"));
    expect(stale.body).toMatchObject({ profile: { emailVerified: true } });
  });

  it("updates name and phone (normalised to E.164) and clears them with null", async () => {
    const { app } = setup();
    await request(app).post("/api/me/sync").set(bearer("client"));

    const updated = await request(app)
      .patch("/api/me")
      .set(bearer("client"))
      .send({ name: "  Jeanne d'Arc-Dupont ", phone: "+33 (0)6 12-34-56-78".replace("(0)", "") });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      profile: { name: "Jeanne d'Arc-Dupont", phone: "+33612345678" },
      bookingReadiness: { ready: true, blockers: [] },
    });

    const cleared = await request(app).patch("/api/me").set(bearer("client")).send({ phone: null });
    expect(cleared.body).toMatchObject({
      profile: { phone: null },
      bookingReadiness: { ready: false, blockers: ["phone_missing"] },
    });
  });

  it.each([
    ["national format without +", "06 12 34 56 78"],
    ["too short", "+33 6 12"],
    ["letters", "+33 6 CALL ME"],
    ["not assignable", "+33 0 00 00 00 00"],
    ["too long", `+33${"6".repeat(40)}`],
    ["empty", ""],
  ])("rejects a phone number: %s", async (_label, phone) => {
    const { app, profiles } = setup();
    await request(app).post("/api/me/sync").set(bearer("client"));

    const response = await request(app).patch("/api/me").set(bearer("client")).send({ phone });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "VALIDATION_FAILED", errors: [{ field: ["phone"] }] });
    expect(profiles.all()[0]?.phoneE164).toBeNull();
  });

  it.each([
    ["role", { role: "admin" }],
    ["emailVerified", { emailVerified: true }],
    ["email", { email: "new@example.invalid" }],
    ["firebaseUid", { firebaseUid: "uid-other" }],
    ["id of another profile", { id: "00000000-0000-4000-8000-000000000000", name: "X" }],
    ["isAnonymous", { isAnonymous: false }],
  ])("rejects privileged or foreign fields (%s) without changing anything", async (_label, body) => {
    const { app, profiles } = setup();
    await request(app).post("/api/me/sync").set(bearer("guest"));
    const before = profiles.all()[0];

    const response = await request(app).patch("/api/me").set(bearer("guest")).send(body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(profiles.all()[0]).toEqual(before);
  });

  it("rejects names with control characters or digits, and empty bodies", async () => {
    const { app } = setup();
    await request(app).post("/api/me/sync").set(bearer("client"));

    for (const body of [{ name: "Eve‮evil" }, { name: "R2D2" }, { name: "" }, {}]) {
      const response = await request(app).patch("/api/me").set(bearer("client")).send(body);
      expect(response.status).toBe(400);
    }
  });

  it("has no way to read or change another user's profile", async () => {
    const { app, profiles } = setup();
    await request(app).post("/api/me/sync").set(bearer("client"));
    await request(app).post("/api/me/sync").set(bearer("other"));
    const otherId = profiles.all().find((row) => row.firebaseUid === "uid-other")?.id ?? "";

    for (const response of [
      await request(app).get(`/api/me/${otherId}`).set(bearer("client")),
      await request(app).patch(`/api/me/${otherId}`).set(bearer("client")).send({ name: "Mallory" }),
      await request(app).get(`/api/profiles/${otherId}`).set(bearer("client")),
    ]) {
      expect(response.status).toBe(404);
    }

    // PATCH /api/me always targets the caller.
    await request(app).patch("/api/me").set(bearer("client")).send({ name: "Mallory" });
    expect(profiles.all().find((row) => row.firebaseUid === "uid-other")?.name).toBeNull();
  });

  it("revokes all sessions of the caller only", async () => {
    const { app, identities } = setup();

    const response = await request(app).post("/api/me/sessions/revoke").set(bearer("client"));

    expect(response.status).toBe(204);
    expect(identities.revoked()).toEqual(["uid-client"]);

    identities.setRevokeOutcome("unavailable");
    const failed = await request(app).post("/api/me/sessions/revoke").set(bearer("client"));
    expect(failed.status).toBe(503);
    expect(failed.body).toMatchObject({ code: "AUTH_UNAVAILABLE" });
  });
});

describe("access guards (for future business routes)", () => {
  it("lets only a booking-ready client book, listing what is missing otherwise", async () => {
    const { app } = setup();

    const guest = await request(app).post("/api/test/booking").set(bearer("guest"));
    expect(guest.status).toBe(403);
    expect(guest.body).toEqual({
      message: "Profile is not ready for booking",
      code: "BOOKING_NOT_READY",
      blockers: ["anonymous_session", "email_not_verified", "name_missing", "phone_missing"],
    });

    await request(app).post("/api/me/sync").set(bearer("client"));
    await request(app).patch("/api/me").set(bearer("client")).send({ phone: "+33612345678" });
    const client = await request(app).post("/api/test/booking").set(bearer("client"));
    expect(client.status).toBe(200);
  });

  it("does not let an admin book, and lets only a verified admin administer", async () => {
    const { app, profiles } = setup();
    await request(app).post("/api/me/sync").set(bearer("client"));
    await request(app).patch("/api/me").set(bearer("client")).send({ phone: "+33612345678" });

    expect((await request(app).post("/api/test/admin").set(bearer("client"))).status).toBe(403);

    profiles.setRole("uid-client", "admin");
    expect((await request(app).post("/api/test/admin").set(bearer("client"))).status).toBe(200);
    const booking = await request(app).post("/api/test/booking").set(bearer("client"));
    expect(booking.status).toBe(403);
    expect(booking.body).toMatchObject({ blockers: ["not_a_client"] });
  });

  it("requires authentication before any guard", async () => {
    const { app } = setup();
    expect((await request(app).post("/api/test/booking")).status).toBe(401);
    expect((await request(app).post("/api/test/admin")).status).toBe(401);
  });
});
