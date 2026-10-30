import type { EmailProvider, OutgoingEmail, SendOutcome } from "../../src/notifications/provider.js";

/**
 * In-memory email provider for worker tests. Accepted emails are recorded,
 * nothing leaves the process. Emulates Brevo's idempotency: a repeat of an
 * idempotency key within `ttlMs` of its acceptance is answered "duplicate"
 * and not sent again; after the TTL it would be sent again.
 */
export type FakeBehavior = (email: OutgoingEmail, call: number) => SendOutcome | "accept";

export const createFakeEmailProvider = ({ now, ttlMs = 30 * 60_000 }: { now: () => Date; ttlMs?: number }) => {
  const sent: (OutgoingEmail & { at: Date })[] = [];
  const acceptedKeys = new Map<string, number>();
  let behavior: FakeBehavior = () => "accept";
  let calls = 0;
  let gate: Promise<void> | undefined;

  const provider: EmailProvider = {
    send: async (email) => {
      calls += 1;
      const call = calls;
      if (gate !== undefined) {
        await gate;
      }
      const decided = behavior(email, call);
      if (decided !== "accept") {
        return decided;
      }
      const acceptedAt = acceptedKeys.get(email.idempotencyKey);
      if (acceptedAt !== undefined && now().getTime() - acceptedAt < ttlMs) {
        return { kind: "duplicate" };
      }
      acceptedKeys.set(email.idempotencyKey, now().getTime());
      sent.push({ ...email, at: now() });
      return { kind: "accepted", providerMessageId: `<fake-${String(sent.length)}@test>` };
    },
  };

  return {
    provider,
    sent,
    calls: () => calls,
    setBehavior: (next: FakeBehavior) => {
      behavior = next;
    },
    /** Holds every send until the returned function is called. */
    hold: (): (() => void) => {
      let release: () => void = () => undefined;
      gate = new Promise((resolve) => {
        release = () => {
          gate = undefined;
          resolve();
        };
      });
      return release;
    },
  };
};
