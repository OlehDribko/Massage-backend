import type { NextFunction, RequestHandler, Response } from "express";
import type { z } from "zod";

export type ValidatedBodyHandler<Body> = (
  body: Body,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

/**
 * Validates req.body (unknown at the HTTP boundary) with the schema and passes
 * only the parsed data to the handler. Invalid bodies get the standard 400 response.
 */
export const withValidatedBody = <Schema extends z.ZodType>(
  schema: Schema,
  handler: ValidatedBodyHandler<z.output<Schema>>,
): RequestHandler<Record<string, string>, unknown, unknown> => {
  return async (req, res, next) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const errorMessages = result.error.issues.map((issue) => {
        return { field: issue.path, message: issue.message };
      });

      res.status(400).json({ message: "Validation failed", errors: errorMessages });
      return;
    }

    await handler(result.data, res, next);
  };
};
