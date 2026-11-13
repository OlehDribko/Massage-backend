import type { Request, RequestHandler } from "express";
import type { UserProfile } from "../../generated/prisma/client.js";
import { requireIdentity } from "../../http/auth/authenticate.js";
import { AppError } from "../../shared/errors/app-error.js";
import type { ProfileService } from "../profiles/profile.service.js";
import { bookingReadiness, canManageCatalog } from "./policies.js";

const actors = new WeakMap<Request, UserProfile>();

/** Profile loaded by a guard below; for handlers mounted after one. */
export const requireActor = (req: Request): UserProfile => {
  const actor = actors.get(req);
  if (actor === undefined) {
    throw new AppError(403, "Forbidden", { code: "FORBIDDEN" });
  }
  return actor;
};

/**
 * Route guards for business routes; mount after `authenticate`.
 * Each guard syncs the profile from the verified token first, so decisions
 * use the current verification state, never client-supplied fields.
 */
export const createAccessGuards = (profiles: ProfileService) => {
  const loadActor = async (req: Request): Promise<UserProfile> => {
    const actor = await profiles.sync(requireIdentity(req));
    actors.set(req, actor);
    return actor;
  };

  /** Any signed-in user (guests too): loads the profile for the handler. */
  const requireProfile: RequestHandler = async (req, _res, next) => {
    await loadActor(req);
    next();
  };

  /**
   * A registered, verified, named client with a phone (bookingReadiness);
   * otherwise 403 with `code` and every blocker.
   */
  const readyClient =
    (code: string, message: string): RequestHandler =>
    async (req, _res, next) => {
      const readiness = bookingReadiness(await loadActor(req));
      if (!readiness.ready) {
        next(new AppError(403, message, { code, details: { blockers: readiness.blockers } }));
        return;
      }
      next();
    };

  /** Booking for oneself. */
  const requireBookingClient = readyClient("BOOKING_NOT_READY", "Profile is not ready for booking");

  /** Gift card requests: the same profile requirements as booking, no calendar rules. */
  const requireGiftCardClient = readyClient(
    "GIFT_CARD_REQUEST_NOT_READY",
    "Profile is not ready for a gift card request",
  );

  /** Catalogue, schedule and other administration. */
  const requireAdmin: RequestHandler = async (req, _res, next) => {
    if (!canManageCatalog(await loadActor(req))) {
      next(new AppError(403, "Forbidden", { code: "FORBIDDEN" }));
      return;
    }
    next();
  };

  return { requireProfile, requireBookingClient, requireGiftCardClient, requireAdmin };
};
