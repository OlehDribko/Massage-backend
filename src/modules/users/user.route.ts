import { Router } from "express";
import { validateCreateUser } from "./user.middlewares.js";
import { createUser } from "./user.controller.js";
import { subscribeToMarketing } from "./user.controller.js";
import { validateSubscribeToMarketing } from "./user.middlewares.js";
const router = Router();

router.post("/", validateCreateUser, createUser);

router.post("/subscribe", validateSubscribeToMarketing, subscribeToMarketing);

export default router;
