import { randomUUID } from "node:crypto";
import type { MarketingSubscription, UserProfile } from "../../src/generated/prisma/client.js";
import type { MarketingRepository } from "../../src/modules/marketing/marketing.repository.js";
import type { ProfileRepository } from "../../src/modules/profiles/profile.repository.js";

// Same observable rules as the Prisma repositories (the real ones are
// covered by the PostgreSQL integration tests).

export const createInMemoryProfileRepository = () => {
  const rows = new Map<string, UserProfile>();

  const repository: ProfileRepository = {
    syncIdentity: (identity, defaultName) => {
      const now = new Date();
      const existing = rows.get(identity.uid);
      const identityFields = {
        email: identity.email ?? null,
        emailVerified: identity.emailVerified,
        isAnonymous: identity.isAnonymous,
        signInProvider: identity.signInProvider,
        identityIssuedAt: identity.issuedAt,
      };
      if (existing === undefined) {
        rows.set(identity.uid, {
          id: randomUUID(),
          firebaseUid: identity.uid,
          role: "client",
          name: defaultName,
          phoneE164: null,
          createdAt: now,
          updatedAt: now,
          ...identityFields,
        });
      } else if (existing.identityIssuedAt.getTime() <= identity.issuedAt.getTime()) {
        rows.set(identity.uid, { ...existing, ...identityFields, updatedAt: now });
      }
      const row = rows.get(identity.uid);
      if (row === undefined) {
        throw new Error("unreachable");
      }
      return Promise.resolve(row);
    },
    findByFirebaseUid: (uid) => Promise.resolve(rows.get(uid) ?? null),
    updateOwnFields: (uid, changes) => {
      const existing = rows.get(uid);
      if (existing === undefined) {
        return Promise.resolve(null);
      }
      const updated = { ...existing, ...changes, updatedAt: new Date() };
      rows.set(uid, updated);
      return Promise.resolve(updated);
    },
  };

  return {
    repository,
    all: () => [...rows.values()],
    setRole: (uid: string, role: UserProfile["role"]) => {
      const existing = rows.get(uid);
      if (existing !== undefined) {
        rows.set(uid, { ...existing, role });
      }
    },
  };
};

export const createInMemoryMarketingRepository = () => {
  const rows = new Map<string, MarketingSubscription>();
  const byEmail = (email: string) => [...rows.values()].find((row) => row.email === email);
  const update = (id: string, changes: Partial<MarketingSubscription>) => {
    const row = rows.get(id);
    if (row !== undefined) {
      rows.set(id, { ...row, ...changes, updatedAt: new Date() });
    }
  };

  const repository: MarketingRepository = {
    ensureExists: (email) => {
      const existing = byEmail(email);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      const now = new Date();
      const row: MarketingSubscription = {
        id: randomUUID(),
        email,
        status: "pending",
        confirmationNonce: null,
        confirmationSentAt: null,
        subscribedAt: null,
        unsubscribedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return Promise.resolve(row);
    },
    claimConfirmationSend: (id, nonce, sentAt, cooldownSince) => {
      const row = rows.get(id);
      if (
        row === undefined ||
        row.status === "subscribed" ||
        (row.confirmationSentAt !== null && row.confirmationSentAt >= cooldownSince)
      ) {
        return Promise.resolve(false);
      }
      update(id, { confirmationNonce: nonce, confirmationSentAt: sentAt });
      return Promise.resolve(true);
    },
    releaseConfirmationClaim: (id, nonce) => {
      if (rows.get(id)?.confirmationNonce === nonce) {
        update(id, { confirmationNonce: null, confirmationSentAt: null });
      }
      return Promise.resolve();
    },
    confirm: (id, nonce) => {
      const row = rows.get(id);
      if (row === undefined || row.confirmationNonce !== nonce || row.status === "subscribed") {
        return Promise.resolve(false);
      }
      update(id, { status: "subscribed", subscribedAt: new Date(), unsubscribedAt: null, confirmationNonce: null });
      return Promise.resolve(true);
    },
    findById: (id) => Promise.resolve(rows.get(id) ?? null),
    unsubscribe: (id) => {
      const row = rows.get(id);
      if (row !== undefined && row.status !== "unsubscribed") {
        update(id, { status: "unsubscribed", unsubscribedAt: new Date(), confirmationNonce: null });
      }
      return Promise.resolve();
    },
  };

  return { repository, byEmail, all: () => [...rows.values()] };
};
