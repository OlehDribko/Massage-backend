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
  const cleared = {
    confirmationNonce: null,
    confirmationSentAt: null,
    confirmationSource: null,
    confirmationTextVersion: null,
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
        subscribed: false,
        consentGivenAt: null,
        consentSource: null,
        consentTextVersion: null,
        unsubscribedAt: null,
        ...cleared,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return Promise.resolve(row);
    },
    findByEmail: (email) => Promise.resolve(byEmail(email) ?? null),
    findById: (id) => Promise.resolve(rows.get(id) ?? null),
    claimConfirmation: (id, claim) => {
      const row = rows.get(id);
      if (row === undefined || row.subscribed) {
        return Promise.resolve(false);
      }
      const allowed =
        claim.mode === "signup"
          ? row.unsubscribedAt === null && row.consentGivenAt === null && row.confirmationSentAt === null
          : row.confirmationSentAt === null || row.confirmationSentAt < claim.cooldownSince;
      if (!allowed) {
        return Promise.resolve(false);
      }
      update(id, {
        confirmationNonce: claim.nonce,
        confirmationSentAt: claim.sentAt,
        confirmationSource: claim.consent.source,
        confirmationTextVersion: claim.consent.textVersion,
      });
      return Promise.resolve(true);
    },
    releaseConfirmation: (id, nonce) => {
      if (rows.get(id)?.confirmationNonce === nonce) {
        update(id, cleared);
      }
      return Promise.resolve();
    },
    confirm: (id, nonce, at) => {
      const row = rows.get(id);
      if (row === undefined || row.subscribed || row.confirmationNonce !== nonce) {
        return Promise.resolve(false);
      }
      update(id, {
        subscribed: true,
        consentGivenAt: at,
        consentSource: row.confirmationSource,
        consentTextVersion: row.confirmationTextVersion,
        unsubscribedAt: null,
        ...cleared,
      });
      return Promise.resolve(true);
    },
    unsubscribe: (id, at) => {
      const row = rows.get(id);
      if (row !== undefined && (row.subscribed || row.confirmationNonce !== null)) {
        update(id, { subscribed: false, unsubscribedAt: at, ...cleared });
      }
      return Promise.resolve();
    },
  };

  return { repository, byEmail, all: () => [...rows.values()] };
};
