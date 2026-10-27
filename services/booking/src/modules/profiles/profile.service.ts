import type { UserProfile } from "../../generated/prisma/client.js";
import { bookingReadiness, type BookingReadiness } from "../access/policies.js";
import type { VerifiedIdentity } from "../auth/identity.js";
import { AppError } from "../../shared/errors/app-error.js";
import type { OwnProfileChanges, ProfileRepository } from "./profile.repository.js";
import { defaultNameFrom, type UpdateOwnProfileRequest } from "./profile.schema.js";

export type ProfileView = {
  profile: {
    id: string;
    role: UserProfile["role"];
    authState: "anonymous" | "registered";
    name: string | null;
    email: string | null;
    emailVerified: boolean;
    phone: string | null;
    signInProvider: string;
    createdAt: string;
    updatedAt: string;
  };
  /** Informational for the UI; booking routes re-check on the server. */
  bookingReadiness: BookingReadiness;
};

// The Firebase UID and internal timestamps stay server-side.
export const toProfileView = (profile: UserProfile): ProfileView => ({
  profile: {
    id: profile.id,
    role: profile.role,
    authState: profile.isAnonymous ? "anonymous" : "registered",
    name: profile.name,
    email: profile.email,
    emailVerified: profile.emailVerified,
    phone: profile.phoneE164,
    signInProvider: profile.signInProvider,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  },
  bookingReadiness: bookingReadiness(profile),
});

const profileNotFound = () =>
  new AppError(404, "Profile not found; call POST /api/me/sync first", { code: "PROFILE_NOT_FOUND" });

export type ProfileService = ReturnType<typeof createProfileService>;

export const createProfileService = (repository: ProfileRepository) => {
  const sync = (identity: VerifiedIdentity): Promise<UserProfile> =>
    repository.syncIdentity(identity, defaultNameFrom(identity.name));

  const getOwn = async (identity: VerifiedIdentity): Promise<UserProfile> => {
    const profile = await repository.findByFirebaseUid(identity.uid);
    if (profile === null) {
      throw profileNotFound();
    }
    return profile;
  };

  // Always the caller's own profile, located by the verified identity; the
  // request cannot name another profile.
  const updateOwn = async (
    identity: VerifiedIdentity,
    request: UpdateOwnProfileRequest,
  ): Promise<UserProfile> => {
    const changes: OwnProfileChanges = {};
    if (request.name !== undefined) {
      changes.name = request.name;
    }
    if (request.phone !== undefined) {
      changes.phoneE164 = request.phone;
    }

    const profile = await repository.updateOwnFields(identity.uid, changes);
    if (profile === null) {
      throw profileNotFound();
    }
    return profile;
  };

  return { sync, getOwn, updateOwn };
};
