import type { Request, Response, NextFunction } from "express";
import { actionTokenSchema } from "../schema/email.schema.js";

export const validateActionToken = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const result = actionTokenSchema.safeParse(req.body);

  if (!result.success) {
    const errorMessages = result.error.issues.map((issue) => {
      return { field: issue.path, message: issue.message };
    });

    return res
      .status(400)
      .json({ message: "Validation failed", errors: errorMessages });
  }

  req.body = result.data;
  next();
};

export default validateActionToken;
