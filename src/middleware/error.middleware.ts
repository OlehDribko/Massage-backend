import type { Request, Response, NextFunction } from "express";
import { AppError } from "../shared/errors/app-error.js";

export const errorHandler = (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ message: error.message });
  }

  return res.status(500).json({ message: "internal server error" });
};
