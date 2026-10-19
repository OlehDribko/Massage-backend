import { randomUUID } from "node:crypto";
import type { Request, RequestHandler } from "express";
import type { Logger } from "../logging/logger.js";

const requestIds = new WeakMap<Request, string>();

export const REQUEST_ID_HEADER = "X-Request-Id";

/** Server-generated id of the current request (never taken from the client). */
export const getRequestId = (req: Request): string | undefined => requestIds.get(req);

const MAX_LOGGED_PATH_LENGTH = 200;

// Path only: the query string may carry tokens and is never logged.
const pathWithoutQuery = (originalUrl: string): string => {
  const queryStart = originalUrl.indexOf("?");
  const path = queryStart === -1 ? originalUrl : originalUrl.slice(0, queryStart);
  return path.length > MAX_LOGGED_PATH_LENGTH
    ? `${path.slice(0, MAX_LOGGED_PATH_LENGTH)}…`
    : path;
};

const isHealthPath = (path: string): boolean => path.startsWith("/health/");

/**
 * Assigns a request id and logs method, path, status and duration when the
 * response finishes or the connection closes. Headers, cookies, query and body
 * are not logged. Successful health checks are logged at debug level only.
 */
export const createRequestLogging = (logger: Logger): RequestHandler => {
  return (req, res, next) => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    const path = pathWithoutQuery(req.originalUrl);
    let logged = false;

    requestIds.set(req, requestId);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const logCompletion = (aborted: boolean) => {
      if (logged) {
        return;
      }
      logged = true;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const fields = {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        ...(aborted ? { aborted: true } : {}),
      };

      if (res.statusCode >= 500) {
        logger.error(fields, "request completed");
      } else if (aborted || res.statusCode >= 400 || !isHealthPath(path)) {
        logger.info(fields, "request completed");
      } else {
        logger.debug(fields, "request completed");
      }
    };

    res.on("finish", () => logCompletion(false));
    res.on("close", () => logCompletion(!res.writableFinished));

    next();
  };
};
