import { Router, type RequestHandler } from "express";
import { requireIdentity } from "../../http/auth/authenticate.js";
import type { IdentityProvider } from "../auth/identity.js";
import { AppError } from "../../shared/errors/app-error.js";
import { withValidatedBody } from "../../shared/http/validated-body.js";
import { updateOwnProfileSchema } from "./profile.schema.js";
import { toProfileView, type ProfileService } from "./profile.service.js";

/**
 * /api/me: the caller's own profile. Every route requires a verified
 * Firebase ID token; there is no route that takes another user's id.
 */
export const createProfileRouter = ({
  authenticate,
  profiles,
  identityProvider,
}: {
  authenticate: RequestHandler;
  profiles: ProfileService;
  identityProvider: IdentityProvider;
}): Router => {
  const router = Router();
  router.use(authenticate);

  // Create or refresh the profile from the token. Call after sign-in, after
  // linking an anonymous session and after a forced token refresh.
  router.post("/sync", async (req, res) => {
    const profile = await profiles.sync(requireIdentity(req));
    res.status(200).json(toProfileView(profile));
  });

  router.get("/", async (req, res) => {
    const profile = await profiles.getOwn(requireIdentity(req));
    res.status(200).json(toProfileView(profile));
  });

  router.patch(
    "/",
    withValidatedBody(updateOwnProfileSchema, async (body, res, _next, req) => {
      const profile = await profiles.updateOwn(requireIdentity(req), body);
      res.status(200).json(toProfileView(profile));
    }),
  );

  // Sign out everywhere: revokes refresh tokens; ID tokens issued before now
  // are rejected by the server from the next request on.
  router.post("/sessions/revoke", async (req, res) => {
    const outcome = await identityProvider.revokeAllSessions(requireIdentity(req).uid);
    if (outcome === "unavailable") {
      throw new AppError(503, "Authentication is temporarily unavailable; retry later", {
        code: "AUTH_UNAVAILABLE",
        details: { retryAfterSeconds: 5 },
      });
    }
    res.status(204).end();
  });

  return router;
};
