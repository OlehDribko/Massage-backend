import type { Response } from "express";
import type { ForgotPasswordResult } from "../types/user.types.js";

export const sendForgotPasswordResponse = (
  res: Response,
  result: ForgotPasswordResult,
) => {
  if (result.code === "ACCOUNT_NOT_FOUND") {
    return res.status(404).json(result);
  }

  if (result.code === "PASSWORD_RESET_UNAVAILABLE") {
    return res.status(400).json(result);
  }

  return res.status(200).json(result);
};
