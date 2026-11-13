/** Error codes of database failures, read without trusting their shape. */

const PRISMA_CODE = /^P[1-9]\d{3}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;

const isSqlState = (value: unknown): value is string =>
  typeof value === "string" && SQLSTATE.test(value) && !PRISMA_CODE.test(value);

/** SQLSTATE of a PostgreSQL error wrapped by Prisma's driver adapter, if any. */
export const postgresErrorCode = (error: unknown, depth = 0): string | undefined => {
  if (typeof error !== "object" || error === null || depth > 6) {
    return undefined;
  }
  if ("originalCode" in error && isSqlState(error.originalCode)) {
    return error.originalCode;
  }
  if ("code" in error && isSqlState(error.code)) {
    return error.code;
  }
  const nested = [
    "cause" in error ? error.cause : undefined,
    "meta" in error ? error.meta : undefined,
    "driverAdapterError" in error ? error.driverAdapterError : undefined,
  ];
  for (const value of nested) {
    const found = postgresErrorCode(value, depth + 1);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
};

/** Prisma's own error code (P1xxx–P3xxx), if any. */
export const prismaErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && PRISMA_CODE.test(error.code)
    ? error.code
    : undefined;
