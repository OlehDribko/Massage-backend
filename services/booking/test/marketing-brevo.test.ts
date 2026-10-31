import { describe, expect, it } from "vitest";
import { z } from "zod";
import { idempotencyKeyFor } from "../src/integrations/brevo/idempotency.js";
import { MARKETING_BREVO_TIMEOUT_MS, createBrevoMarketingMailer } from "../src/modules/email/service/email.service.js";

// Marketing mailer with the real Brevo SDK and a fake transport: no network,
// no email is sent.

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const mailerWith = (respond: () => Response) => {
  const bodies: unknown[] = [];
  const mailer = createBrevoMarketingMailer({
    brevoApiKey: "xkeysib-test",
    fromName: "Studio",
    fromEmail: "noreply@example.invalid",
    fetchImpl: (_input, init) => {
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
      return Promise.resolve(respond());
    },
  });
  return { mailer, bodies };
};

const KEY = idempotencyKeyFor("marketing_confirmation_request", "sub-1", "nonce-1");

describe("marketing mailer (Brevo)", () => {
  it("sends the idempotency key and reports acceptance", async () => {
    const { mailer, bodies } = mailerWith(() => json(201, { messageId: "<m@brevo>" }));
    expect(await mailer.sendConfirmationRequest("a@example.invalid", "https://front.example.invalid/x", KEY)).toEqual({ kind: "accepted" });
    expect(z.object({ headers: z.object({ idempotencyKey: z.string() }) }).parse(bodies[0]).headers.idempotencyKey).toBe(KEY);
  });

  it("no SDK retries: a 5xx is one call and an unknown outcome", async () => {
    const { mailer, bodies } = mailerWith(() => json(503, { message: "busy" }));
    expect(await mailer.sendConfirmationRequest("a@example.invalid", "https://x.invalid/", KEY)).toEqual({ kind: "uncertain", code: "provider_unavailable" });
    expect(bodies).toHaveLength(1);
  });

  it("429 is handled on its own: refused and not processed, so 'not sent' (one call, no retry)", async () => {
    const { mailer, bodies } = mailerWith(() => json(429, { message: "slow down" }, { "retry-after": "30" }));
    expect(await mailer.sendConfirmationRequest("a@example.invalid", "https://x.invalid/", KEY)).toEqual({ kind: "not_sent", code: "rate_limited" });
    expect(bodies).toHaveLength(1);
  });

  it("a repeat Brevo already accepted (duplicate_parameter) counts as accepted; 401 and other 4xx are not sent", async () => {
    expect(await mailerWith(() => json(400, { code: "duplicate_parameter" })).mailer.sendSubscriptionConfirmed("a@example.invalid", "https://x.invalid/", KEY)).toEqual({ kind: "accepted" });
    expect(await mailerWith(() => json(401, { code: "unauthorized" })).mailer.sendSubscriptionConfirmed("a@example.invalid", "https://x.invalid/", KEY)).toEqual({ kind: "not_sent", code: "provider_auth" });
    expect(await mailerWith(() => json(400, { code: "invalid_parameter" })).mailer.sendSubscriptionConfirmed("a@example.invalid", "https://x.invalid/", KEY)).toEqual({ kind: "not_sent", code: "provider_rejected" });
  });

  it("the Brevo call is limited to 10 s (this bounds the call, not the whole HTTP request)", () => {
    expect(MARKETING_BREVO_TIMEOUT_MS).toBe(10_000);
  });

  it("idempotency keys are deterministic UUIDs that differ per operation", () => {
    expect(idempotencyKeyFor("marketing_confirmation_request", "sub-1", "nonce-1")).toBe(KEY);
    expect(idempotencyKeyFor("marketing_confirmation_request", "sub-1", "nonce-2")).not.toBe(KEY);
    expect(idempotencyKeyFor("marketing_subscription_confirmed", "sub-1", "nonce-1")).not.toBe(KEY);
    // Parts are length-prefixed: no collision by moving a separator.
    expect(idempotencyKeyFor("a|b", "c")).not.toBe(idempotencyKeyFor("a", "b|c"));
    expect(z.uuid().safeParse(KEY).success).toBe(true);
  });
});
