import type { ErrorRequestHandler, RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../shared/errors/app-error.js";
import { describeError, type Logger } from "../logging/logger.js";
import { getRequestId } from "../http/request-logging.js";

// Errors raised by express.json() (body-parser). Only these known `type`
// values are mapped; an arbitrary error.status/statusCode is never trusted.
const bodyParserErrorSchema = z.object({
  type: z.enum([
    "entity.parse.failed",
    "entity.too.large",
    "encoding.unsupported",
    "charset.unsupported",
  ]),
});

const bodyParserResponses = {
  "entity.parse.failed": {
    status: 400,
    body: { message: "Malformed JSON request body", code: "INVALID_JSON" },
  },
  "entity.too.large": {
    status: 413,
    body: { message: "Request body too large", code: "PAYLOAD_TOO_LARGE" },
  },
  "encoding.unsupported": {
    status: 415,
    body: { message: "Unsupported request encoding", code: "UNSUPPORTED_ENCODING" },
  },
  "charset.unsupported": {
    status: 415,
    body: { message: "Unsupported request charset", code: "UNSUPPORTED_CHARSET" },
  },
} satisfies Record<
  z.output<typeof bodyParserErrorSchema>["type"],
  { status: number; body: { message: string; code: string } }
>;

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ message: "Not found", code: "NOT_FOUND" });
};

export const createErrorHandler = (logger: Logger): ErrorRequestHandler => {
  // Express identifies error handlers by arity, so all four parameters stay.
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      // Too late to send a JSON error; Express closes the connection. Its final
      // handler prints err.stack (including the message) to stderr, so a neutral
      // error is passed on and the original is logged in safe form here.
      logger.error(
        { requestId: getRequestId(req), error: describeError(error) },
        "error after response headers were sent",
      );
      next(new Error("Error after response headers were sent"));
      return;
    }

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

      if (error.statusCode >= 500) {
        logger.error(
          {
            requestId: getRequestId(req),
            statusCode: error.statusCode,
            error: describeError(error),
          },
          "request failed with server error",
        );
      }

      res.status(error.statusCode).json(body);
      return;
    }

    const bodyParserError = bodyParserErrorSchema.safeParse(error);
    if (bodyParserError.success) {
      const response = bodyParserResponses[bodyParserError.data.type];
      res.status(response.status).json(response.body);
      return;
    }

    logger.error(
      { requestId: getRequestId(req), error: describeError(error) },
      "unhandled error",
    );
    res.status(500).json({ message: "internal server error" });
  };
};
