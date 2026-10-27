import type { PrismaClient, UserProfile } from "../../generated/prisma/client.js";
import type { VerifiedIdentity } from "../auth/identity.js";

export type OwnProfileChanges = {
  name?: string | null;
  phoneE164?: string | null;
};

export type ProfileRepository = {
  /**
   * Creates the profile for this identity if absent, then applies the
   * identity fields unless a newer token has already been applied.
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
      identityIssuedAt: identity.issuedAt,
    };

    // INSERT … ON CONFLICT DO NOTHING: concurrent first requests of the same
    // user create exactly one row and none of them fails.
    await prisma.userProfile.createMany({
      data: [{ firebaseUid: identity.uid, name: defaultName, ...identityFields }],
      skipDuplicates: true,
    });

    // A token older than the one already applied (e.g. a request that raced
    // a refresh after email verification) must not roll the profile back.
    await prisma.userProfile.updateMany({
      where: { firebaseUid: identity.uid, identityIssuedAt: { lte: identity.issuedAt } },
      data: identityFields,
    });

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
