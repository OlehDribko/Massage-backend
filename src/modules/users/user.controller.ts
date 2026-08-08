import type { Request, Response } from "express";
import type { CreateUserRequest } from "./user.schema.js";
import type { NextFunction } from "express";
import { registerUser } from "./user.service.js";

export const createUser = async (
  req: Request<{}, {}, CreateUserRequest>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = await registerUser(req.body);
    const data = {
      id: user.id,
      name: user.name,
      email: user.email,
      status: user.status,
      marketingConsent: user.marketingConsent,
    };

    res.status(201).json({ message: "User created successfully", data });
  } catch (error) {
    next(error);
  }
};
