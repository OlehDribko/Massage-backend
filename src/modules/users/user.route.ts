import { Router } from "express";
import { validateCreateUser } from "./user.middlewares.js";
import { createUser } from "./user.controller.js";

const router = Router();

router.post("/", validateCreateUser, createUser);

export default router;
