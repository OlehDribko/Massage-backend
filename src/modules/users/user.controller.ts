import type { Request, Response } from "express";
import type { NextFunction } from "express";
import type { CreateUserRequest } from "./user.schema.js";
import type { SubscribeToMarketingRequest } from "./user.schema.js";

import { registerUser } from "./user.service.js";
import { subscribedToMarketingService } from "./user.service.js";

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

export const subscribeToMarketing = async (
  req: Request<{}, {}, SubscribeToMarketingRequest>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { email } = req.body;

    const { created } = await subscribedToMarketingService(email);

    res
      .status(created ? 201 : 200)
      .json({ message: "User subscribed to marketing successfully" });
  } catch (error) {
    next(error);
  }
};
