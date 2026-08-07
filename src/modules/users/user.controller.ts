import type { Request, Response } from "express";
import type { CreateUserRequest } from "./user.schema.js";
import { registerUser } from "./user.service.js";

export const createUser = async (
  req: Request<{}, {}, CreateUserRequest>,
  res: Response,
) => {
  const user = await registerUser(req.body);

  res.status(201).json({ message: "User created successfully", user });
};
