import type { Request, Response, NextFunction } from "express";
import { createUserSchema, subscribeToMarketingSchema } from "./user.schema.js";

export const validateCreateUser = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const result = createUserSchema.safeParse(req.body);

  if (!result.success) {
    const issues = result.error.issues;

    const errorMessages = issues.map((issue) => {
      return { field: issue.path, message: issue.message };
    });

    return res
      .status(400)
      .json({ message: "Validation failed", errors: errorMessages });
  }
  req.body = result.data;
  next();
};

export const validateSubscribeToMarketing = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const result = subscribeToMarketingSchema.safeParse(req.body);

  if (!result.success) {
    const issues = result.error.issues;
    const errorMessages = issues.map((issue) => {
      return { field: issue.path, message: issue.message };
    });
    return res
      .status(400)
      .json({ message: "Validation failed", errors: errorMessages });
  }
  req.body = result.data;
  next();
};
