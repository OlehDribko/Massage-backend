import cors from "cors";
import type { RequestHandler } from "express";
import { z } from "zod";

/**
 * Browser origins allowed to call the API: exact origins and anchored
 * patterns (preview deployments of one frontend project). Any other origin
 * gets no CORS headers, so the browser blocks the response; requests without
 * an Origin header (curl, server-side rendering) are not affected.
 */
export type CorsPolicy = { origins: string[]; patterns: RegExp[] };

export const CORS_METHODS = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"];
export const CORS_ALLOWED_HEADERS = ["Authorization", "Content-Type", "Idempotency-Key"];
/** Response headers the frontend reads (503 CALENDAR_BUSY / AUTH_UNAVAILABLE, idempotent replays). */
export const CORS_EXPOSED_HEADERS = ["Retry-After", "Idempotent-Replayed"];
/** Browsers may reuse a preflight answer for this long, seconds. */
export const CORS_MAX_AGE_SECONDS = 600;

const MAX_ORIGINS = 20;
const MAX_PATTERNS = 10;
const MAX_PATTERN_LENGTH = 200;
// Longer than any real origin; such headers are refused without running a pattern.
const MAX_ORIGIN_LENGTH = 300;

export const isAllowedOrigin = (policy: CorsPolicy, origin: string): boolean =>
  origin.length <= MAX_ORIGIN_LENGTH &&
  (policy.origins.includes(origin) || policy.patterns.some((pattern) => pattern.test(origin)));

export const createCorsMiddleware = (policy: CorsPolicy): RequestHandler =>
  cors({
    origin: (origin, callback) => {
      callback(null, origin !== undefined && isAllowedOrigin(policy, origin));
    },
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: CORS_MAX_AGE_SECONDS,
  });

const isExactOrigin = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return /^https?:$/.test(url.protocol) && url.origin === value;
};

const originSchema = z
  .string()
  .refine(isExactOrigin, "must be an exact origin such as https://app.example.com (scheme, lowercase host, optional port; no path, no trailing slash, no wildcard)");

const compiles = (value: string): boolean => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
};

const patternSchema = z
  .string()
  .max(MAX_PATTERN_LENGTH, `must be at most ${String(MAX_PATTERN_LENGTH)} characters`)
  .refine((value) => value.startsWith("^https://") && value.endsWith("$"), "must be anchored: start with ^https:// and end with $")
  .refine((value) => !/[|,]/.test(value), "must not contain | or ,")
  // Every dot must be a literal \. so a dynamic part cannot cross into another domain.
  .refine((value) => !/(^|[^\\])\./.test(value), "every . must be escaped as \\.")
  .refine(compiles, "must be a valid regular expression");

const listOf = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

type Loaded = { ok: true; policy: CorsPolicy | undefined } | { ok: false; errors: string[] };

const errorsOf = (name: string, values: string[], schema: z.ZodType, max: number): string[] => {
  const errors = values.flatMap((value, index) => {
    const result = schema.safeParse(value);
    // The message names the variable, the position and the rule, never the value.
    return result.success ? [] : result.error.issues.map((issue) => `${name}[${String(index)}]: ${issue.message}`);
  });
  return values.length > max ? [`${name}: at most ${String(max)} entries`, ...errors] : errors;
};

/**
 * CORS_ALLOWED_ORIGINS (exact origins) and CORS_ALLOWED_ORIGIN_PATTERNS
 * (anchored regular expressions), comma-separated. When neither is set, the
 * origin of FRONTEND_URL is the only allowed one (the earlier behaviour);
 * without any of them CORS is off.
 */
export const loadCorsPolicy = (env: {
  allowedOrigins: string | undefined;
  allowedOriginPatterns: string | undefined;
  frontendUrl: string | undefined;
}): Loaded => {
  const origins = listOf(env.allowedOrigins);
  const patterns = listOf(env.allowedOriginPatterns);
  const errors = [
    ...errorsOf("CORS_ALLOWED_ORIGINS", origins, originSchema, MAX_ORIGINS),
    ...errorsOf("CORS_ALLOWED_ORIGIN_PATTERNS", patterns, patternSchema, MAX_PATTERNS),
  ];
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  if (origins.length > 0 || patterns.length > 0) {
    return { ok: true, policy: { origins: [...new Set(origins)], patterns: patterns.map((pattern) => new RegExp(pattern)) } };
  }
  if (env.frontendUrl !== undefined) {
    return { ok: true, policy: { origins: [new URL(env.frontendUrl).origin], patterns: [] } };
  }
  return { ok: true, policy: undefined };
};
