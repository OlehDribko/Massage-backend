import type { Request, Response } from "express";
import type { CreateUserRequest } from "./user.schema.js";

export const createUser = (
  req: Request<{}, {}, CreateUserRequest>,
  res: Response,
) => {
  // NoN ections ! Should do ections here!
  return res.status(201).json({ message: "User created successfully" });
};
