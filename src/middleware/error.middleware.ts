import type { Request, Response, NextFunction } from "express";
import { AppError } from "../shared/errors/app-error.js";

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ message: err.message });
  }

  return res.status(500).json({ message: "internal server error" });
};
