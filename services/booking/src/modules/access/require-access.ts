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
 * Route guards for future business routes; mount after `authenticate`.
 * Each guard syncs the profile from the verified token first, so decisions
 * use the current verification state, never client-supplied fields.
 */
export const createAccessGuards = (profiles: ProfileService) => {
  const loadActor = async (req: Request): Promise<UserProfile> => {
    const actor = await profiles.sync(requireIdentity(req));
    actors.set(req, actor);
    return actor;
  };

  /** Booking for oneself: registered, verified, named client with a phone. */
  const requireBookingClient: RequestHandler = async (req, _res, next) => {
    const readiness = bookingReadiness(await loadActor(req));
    if (!readiness.ready) {
      next(
        new AppError(403, "Profile is not ready for booking", {
          code: "BOOKING_NOT_READY",
          details: { blockers: readiness.blockers },
        }),
      );
      return;
    }
    next();
  };

  /** Catalogue, schedule and other administration. */
  const requireAdmin: RequestHandler = async (req, _res, next) => {
    if (!canManageCatalog(await loadActor(req))) {
      next(new AppError(403, "Forbidden", { code: "FORBIDDEN" }));
      return;
    }
    next();
  };

  return { requireBookingClient, requireAdmin };
};
