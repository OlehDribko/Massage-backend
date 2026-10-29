import type { PrismaClient, UserRole } from "../../generated/prisma/client.js";

export type RoleAssignmentRequest = {
  profileId: string;
  /** Must equal the profile's email: guards against acting on the wrong id. */
  expectedEmail: string;
  role: UserRole;
  /** false: report what would happen without changing anything. */
  apply: boolean;
};

export type RoleAssignmentRefusal =
  | "profile_not_found"
  | "email_mismatch"
  | "anonymous_session"
  | "email_not_verified";

export type RoleAssignmentResult =
  | { ok: true; profileId: string; previousRole: UserRole; role: UserRole; changed: boolean; applied: boolean }
  | { ok: false; reason: RoleAssignmentRefusal };

/**
 * Owner-run role change (see src/admin/assign-role.ts). There is no HTTP
 * route for this. Granting admin requires a registered (non-anonymous)
 * profile with an email verified by Firebase that matches `expectedEmail`;
 * revoking admin (role client) only requires the email match.
 */
export const assignRole = async (
  prisma: PrismaClient,
  request: RoleAssignmentRequest,
): Promise<RoleAssignmentResult> =>
  prisma.$transaction(async (tx) => {
    const profile = await tx.userProfile.findUnique({ where: { id: request.profileId } });
    if (profile === null) {
      return { ok: false, reason: "profile_not_found" };
    }
    if (profile.email === null || profile.email !== request.expectedEmail.trim().toLowerCase()) {
      return { ok: false, reason: "email_mismatch" };
    }
    if (request.role === "admin") {
      if (profile.isAnonymous) {
        return { ok: false, reason: "anonymous_session" };
      }
      if (!profile.emailVerified) {
        return { ok: false, reason: "email_not_verified" };
      }
    }

    const changed = profile.role !== request.role;
    if (changed && request.apply) {
      // Conditional on the state just checked, so a concurrent change is not overwritten.
      const updated = await tx.userProfile.updateMany({
        where: { id: profile.id, role: profile.role, email: profile.email },
        data: { role: request.role },
      });
      if (updated.count !== 1) {
        return { ok: false, reason: "profile_not_found" };
      }
    }

    return {
      ok: true,
      profileId: profile.id,
      previousRole: profile.role,
      role: request.role,
      changed,
      applied: changed && request.apply,
    };
  });
