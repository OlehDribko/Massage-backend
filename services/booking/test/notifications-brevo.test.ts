import { BrevoError, BrevoTimeoutError } from "@getbrevo/brevo";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyBrevoError, createBrevoProvider } from "../src/notifications/brevo-provider.js";
import type { OutgoingEmail } from "../src/notifications/provider.js";

// The real Brevo SDK with a fake transport: no network, no email is sent.

type Captured = { url: string; headers: Headers; body: unknown };

const fakeFetch = (respond: () => Response, captured: Captured[]): typeof fetch =>
  async (input, init) => {
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, headers: new Headers(init?.headers), body });
    return Promise.resolve(respond());
  };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const EMAIL: OutgoingEmail = {
  to: "anna@example.invalid",
  subject: "Votre rendez-vous est confirmé",
  html: "<p>Bonjour</p>",
  text: "Bonjour",
  idempotencyKey: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  tags: ["booking.created", "client"],
};

const providerWith = (respond: () => Response, captured: Captured[] = []) =>
  createBrevoProvider({
    apiKey: "xkeysib-test",
    senderName: "Studio",
    senderEmail: "noreply@example.invalid",
    requestTimeoutMs: 20_000,
    fetchImpl: fakeFetch(respond, captured),
  });

describe("Brevo adapter", () => {
  it("sends one request with the stable idempotency key, HTML and text; accepted with the message id", async () => {
    const captured: Captured[] = [];
    const provider = providerWith(() => json(201, { messageId: "<msg-1@smtp-relay.mailin.fr>" }), captured);

    expect(await provider.send(EMAIL)).toEqual({ kind: "accepted", providerMessageId: "<msg-1@smtp-relay.mailin.fr>" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toContain("/v3/smtp/email");
    expect(captured[0]?.headers.get("api-key")).toBe("xkeysib-test");
    expect(z.object({}).passthrough().parse(captured[0]?.body)).toMatchObject({
      sender: { name: "Studio", email: "noreply@example.invalid" },
      to: [{ email: "anna@example.invalid" }],
      subject: EMAIL.subject,
      htmlContent: EMAIL.html,
      textContent: EMAIL.text,
      headers: { idempotencyKey: EMAIL.idempotencyKey },
      tags: EMAIL.tags,
    });
  });

  it("does not retry inside the SDK (the worker owns retries)", async () => {
    const captured: Captured[] = [];
    const provider = providerWith(() => json(503, { code: "unavailable" }), captured);
    expect(await provider.send(EMAIL)).toEqual({ kind: "retryable", code: "provider_unavailable", retryAfterMs: null });
    expect(captured).toHaveLength(1);
  });

  it.each([
    ["400 duplicate_parameter (key already processed)", () => json(400, { code: "duplicate_parameter", message: "x" }), { kind: "duplicate" }],
    ["400 invalid_parameter", () => json(400, { code: "invalid_parameter", message: "email is not valid" }), { kind: "rejected", code: "provider_rejected" }],
    ["404", () => json(404, { code: "document_not_found" }), { kind: "rejected", code: "provider_rejected" }],
    ["401 wrong key", () => json(401, { code: "unauthorized" }), { kind: "configuration", code: "provider_auth" }],
    ["403 not permitted", () => json(403, { code: "permission_denied" }), { kind: "configuration", code: "provider_forbidden" }],
    ["402 account", () => json(402, { code: "not_enough_credits" }), { kind: "configuration", code: "provider_account" }],
    ["429 with Retry-After seconds", () => json(429, { code: "too_many_requests" }, { "retry-after": "120" }), { kind: "retryable", code: "rate_limited", retryAfterMs: 120_000 }],
    ["429 without Retry-After", () => json(429, {}), { kind: "retryable", code: "rate_limited", retryAfterMs: null }],
    ["500", () => json(500, {}), { kind: "retryable", code: "provider_unavailable", retryAfterMs: null }],
  ])("classifies %s", async (_label, respond, expected) => {
    expect(await providerWith(respond).send(EMAIL)).toEqual(expected);
  });

  it("classifies timeouts and network failures as retryable, without provider text", () => {
    expect(classifyBrevoError(new BrevoTimeoutError("Timeout exceeded"))).toEqual({ kind: "retryable", code: "timeout", retryAfterMs: null });
    expect(classifyBrevoError(new TypeError("fetch failed"))).toEqual({ kind: "retryable", code: "network", retryAfterMs: null });
    expect(classifyBrevoError(new BrevoError({ message: "no status" }))).toEqual({ kind: "retryable", code: "network", retryAfterMs: null });
  });

  it("network errors from the transport become retryable outcomes, not exceptions", async () => {
    const provider = createBrevoProvider({
      apiKey: "k",
      senderName: "S",
      senderEmail: "s@example.invalid",
      requestTimeoutMs: 20_000,
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(await provider.send(EMAIL)).toMatchObject({ kind: "retryable" });
  });
});
