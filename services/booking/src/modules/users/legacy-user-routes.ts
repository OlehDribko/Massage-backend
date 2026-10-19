import type { PrismaClient } from "@prisma/client";
import type { Router } from "express";
import type { LegacyUserRoutesConfig } from "../../config/config.js";
import type { Logger } from "../../logging/logger.js";
import { createActionTokenService } from "../email/tokens/action-token.service.js";
import { createEmailService } from "../email/service/email.service.js";
import { createUserRepository } from "./repository/user.repository.js";
import { createUserService } from "./service/user.service.js";
import { createUserControllers } from "./controller/user.controller.js";
import { createUserRouter } from "./user.route.js";

/**
 * Wires the legacy /api/users module (password accounts, email verification,
 * marketing subscription via Brevo). Called only when
 * ENABLE_LEGACY_USER_ROUTES=true; the Brevo client is created here, not on import.
 */
export const createLegacyUserRouter = ({
  prisma,
  config,
  logger,
}: {
  prisma: PrismaClient;
  config: LegacyUserRoutesConfig;
  logger: Logger;
}): Router => {
  const actionTokenService = createActionTokenService(config.actionTokenSecret);
  const emailService = createEmailService(
    {
      brevoApiKey: config.brevoApiKey,
      fromName: config.emailFromName,
      fromEmail: config.emailFromEmail,
      frontendUrl: config.frontendUrl,
    },
    actionTokenService,
    logger,
  );
  const userRepository = createUserRepository(prisma);
  const userService = createUserService({
    userRepository,
    emailService,
    actionTokenService,
    logger,
  });

  return createUserRouter(createUserControllers(userService));
};
