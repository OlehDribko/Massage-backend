import { Router } from "express";
import { createApp } from "../../src/app.js";
import { createAuthenticate } from "../../src/http/auth/authenticate.js";
import { createAccessGuards, requireActor } from "../../src/modules/access/require-access.js";
import { createProfileRouter } from "../../src/modules/profiles/profile.routes.js";
import { createProfileService } from "../../src/modules/profiles/profile.service.js";
import { createFakeIdentityProvider } from "./fake-identity.js";
import { createInMemoryProfileRepository } from "./in-memory-repositories.js";
import { createCapturingLogger } from "./logs.js";

/**
 * App with /api/me and two sample routes guarded like future business
 * routes (/api/test/booking, /api/test/admin).
 */
export const createProfileTestApp = () => {
  const identities = createFakeIdentityProvider();
  const profiles = createInMemoryProfileRepository();
  const logs = createCapturingLogger();
  const service = createProfileService(profiles.repository);
  const authenticate = createAuthenticate(identities.provider);
  const guards = createAccessGuards(service);

  const guarded = Router();
  guarded.use(authenticate);
  guarded.post("/booking", guards.requireBookingClient, (req, res) => {
    res.status(200).json({ actorId: requireActor(req).id });
  });
  guarded.post("/admin", guards.requireAdmin, (req, res) => {
    res.status(200).json({ actorId: requireActor(req).id });
  });

  const api = Router();
  api.use("/me", createProfileRouter({ authenticate, profiles: service, identityProvider: identities.provider }));
  api.use("/test", guarded);

  const app = createApp({
    logger: logs.logger,
    isShuttingDown: () => false,
    probeReadiness: () => Promise.resolve("ready"),
    appVersion: undefined,
    corsOrigin: undefined,
    apiRouter: api,
  });

  return { app, identities, profiles, logs };
};
