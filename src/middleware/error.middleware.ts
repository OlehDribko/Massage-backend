import type { Request, Response, NextFunction } from "express";
import { AppError } from "../shared/errors/app-error.js";

export const errorHandler = (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (error instanceof AppError) {
    const body: Record<string, unknown> = {
      message: error.message,
    };

    if (error.code !== undefined) {
      body.code = error.code;
    }

    if (error.details !== undefined) {
      Object.assign(body, error.details);
    }

    const retryAfterSeconds = error.details?.retryAfterSeconds;
    if (typeof retryAfterSeconds === "number") {
      res.setHeader("Retry-After", String(retryAfterSeconds));
    }

    return res.status(error.statusCode).json(body);
  }

  return res.status(500).json({ message: "internal server error" });
};
