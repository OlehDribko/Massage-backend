import type { PrismaClient, UserProfile } from "../../generated/prisma/client.js";
import type { VerifiedIdentity } from "../auth/identity.js";

export type OwnProfileChanges = {
  name?: string | null;
  phoneE164?: string | null;
};

export type ProfileRepository = {
  /**
   * Creates the profile for this identity if absent, then applies the
   * identity fields unless a newer token has already been applied. Writes
   * only when something changes (new profile, newer token, or the same token
   * time with different claims); otherwise a single read.
   * Idempotent and safe under concurrent calls for the same identity.
   */
  syncIdentity: (identity: VerifiedIdentity, defaultName: string | null) => Promise<UserProfile>;
  findByFirebaseUid: (firebaseUid: string) => Promise<UserProfile | null>;
  /** Updates only the user-editable fields; null when the profile is absent. */
  updateOwnFields: (firebaseUid: string, changes: OwnProfileChanges) => Promise<UserProfile | null>;
};

export const createProfileRepository = (prisma: PrismaClient): ProfileRepository => ({
  syncIdentity: async (identity, defaultName) => {
    const identityFields = {
      email: identity.email ?? null,
      emailVerified: identity.emailVerified,
      isAnonymous: identity.isAnonymous,
      signInProvider: identity.signInProvider,
    };
    const issuedAt = identity.issuedAt;

    // Write only what changes the profile: a newer token, or the same token
    // time with different claims. A token older than the one already applied
    // (e.g. a request that raced a refresh after email verification) never
    // rolls the profile back. The condition is part of the UPDATE itself, so
    // it holds under concurrent requests (no read-then-write race).
    const applyIfNewer = () =>
      prisma.userProfile.updateMany({
        where: {
          firebaseUid: identity.uid,
          OR: [{ identityIssuedAt: { lt: issuedAt } }, { identityIssuedAt: issuedAt, NOT: identityFields }],
        },
        data: { ...identityFields, identityIssuedAt: issuedAt },
      });

    const existing = await prisma.userProfile.findUnique({ where: { firebaseUid: identity.uid } });
    if (existing === null) {
      // INSERT … ON CONFLICT DO NOTHING: concurrent first requests of the same
      // user create exactly one row and none of them fails; a concurrent
      // creator with an older token is then overwritten by the newer one.
      await prisma.userProfile.createMany({
        data: [{ firebaseUid: identity.uid, name: defaultName, ...identityFields, identityIssuedAt: issuedAt }],
        skipDuplicates: true,
      });
      await applyIfNewer();
      return prisma.userProfile.findUniqueOrThrow({ where: { firebaseUid: identity.uid } });
    }

    // Usual case: the same (or an older) token as last time and nothing to
    // change: one read, no write (no row churn on every authenticated request).
    const newer = existing.identityIssuedAt.getTime() < issuedAt.getTime();
    const sameTimeOtherClaims =
      existing.identityIssuedAt.getTime() === issuedAt.getTime() &&
      (existing.email !== identityFields.email ||
        existing.emailVerified !== identityFields.emailVerified ||
        existing.isAnonymous !== identityFields.isAnonymous ||
        existing.signInProvider !== identityFields.signInProvider);
    if (!newer && !sameTimeOtherClaims) {
      return existing;
    }
    await applyIfNewer();
    return prisma.userProfile.findUniqueOrThrow({ where: { firebaseUid: identity.uid } });
  },

  findByFirebaseUid: (firebaseUid) => prisma.userProfile.findUnique({ where: { firebaseUid } }),

  updateOwnFields: async (firebaseUid, changes) => {
    const result = await prisma.userProfile.updateMany({ where: { firebaseUid }, data: changes });
    if (result.count === 0) {
      return null;
    }
    return prisma.userProfile.findUnique({ where: { firebaseUid } });
  },
});
