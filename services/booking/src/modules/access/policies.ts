import type { UserProfile } from "../../generated/prisma/client.js";

/**
 * Server-side access rules. The profile in our database is the only input:
 * roles and verification state are never taken from request bodies, and the
 * role never from the identity provider.
 *
 * Anonymity is an authentication state, the role an authorisation attribute;
 * an anonymous session is always a client and can never hold admin rights
 * (also enforced by a database constraint).
 */
export type Actor = Pick<
  UserProfile,
  "id" | "role" | "isAnonymous" | "emailVerified" | "name" | "phoneE164"
>;

export type BookingBlocker =
  | "anonymous_session"
  | "email_not_verified"
  | "name_missing"
  | "phone_missing"
  | "not_a_client";

export type BookingReadiness = {
  ready: boolean;
  /** Empty when ready; otherwise every reason, in a stable order. */
  blockers: BookingBlocker[];
};

/** What still prevents this actor from booking for themselves. */
export const bookingReadiness = (actor: Actor): BookingReadiness => {
  const blockers: BookingBlocker[] = [];

  if (actor.role !== "client") {
    blockers.push("not_a_client");
  }
  if (actor.isAnonymous) {
    blockers.push("anonymous_session");
  }
  if (!actor.emailVerified) {
    blockers.push("email_not_verified");
  }
  if (actor.name === null) {
    blockers.push("name_missing");
  }
  if (actor.phoneE164 === null) {
    blockers.push("phone_missing");
  }

  return { ready: blockers.length === 0, blockers };
};

const isVerifiedAdmin = (actor: Actor): boolean =>
  actor.role === "admin" && !actor.isAnonymous && actor.emailVerified;

/** A client books for themselves only; admins do not book. */
export const canBookForSelf = (actor: Actor): boolean => bookingReadiness(actor).ready;

/** Services and schedule (future catalogue routes). */
export const canManageCatalog = (actor: Actor): boolean => isVerifiedAdmin(actor);

/** Admins receive notifications about appointments. */
export const receivesAppointmentNotifications = (actor: Actor): boolean => isVerifiedAdmin(actor);

export type AppointmentOwnership = { clientProfileId: string };

/** The owning client, or an admin, may cancel. */
export const canCancelAppointment = (actor: Actor, appointment: AppointmentOwnership): boolean =>
  isVerifiedAdmin(actor) ||
  (actor.role === "client" && !actor.isAnonymous && actor.id === appointment.clientProfileId);

/**
 * Only the owning, booking-ready client may move their own appointment.
 * Admins cannot reschedule other people's appointments.
 */
export const canRescheduleAppointment = (
  actor: Actor,
  appointment: AppointmentOwnership,
): boolean => canBookForSelf(actor) && actor.id === appointment.clientProfileId;
