import { postgresErrorCode, prismaErrorCode } from "../modules/schedule/calendar-transaction.js";

/**
 * Safe cause of a database failure for the owner's commands. Driver and Prisma
 * messages may embed hosts, users or values, so they are never logged; only
 * fixed texts chosen here from codes and known, value-free messages are.
 */
export type DatabaseFailureCause =
  | "connect_timeout"
  | "database_unreachable"
  | "tls_error"
  | "authentication_failed"
  | "database_not_found"
  | "permission_denied"
  | "schema_missing"
  | "query_timeout"
  | "transaction_start_timeout"
  | "transaction_timeout"
  | "transaction_api_error"
  | "unexpected";

const TEXTS: Record<DatabaseFailureCause, string> = {
  connect_timeout: "no database connection within the connect timeout (database asleep or unreachable)",
  database_unreachable: "the database host refused or could not be resolved",
  tls_error: "TLS handshake or certificate verification failed",
  authentication_failed: "the database rejected the credentials",
  database_not_found: "the database named in DATABASE_URL does not exist",
  permission_denied: "the database role lacks a privilege",
  schema_missing: "a table is missing (migrations not applied?)",
  query_timeout: "a query exceeded its time limit",
  transaction_start_timeout: "the transaction could not start in time (no free connection)",
  transaction_timeout: "the transaction exceeded its time limit",
  transaction_api_error: "Prisma transaction API error",
  unexpected: "unexpected error",
};

export type DatabaseFailure = {
  cause: DatabaseFailureCause;
  causeText: string;
  prismaCode?: string;
  sqlState?: string;
};

const SQLSTATE_CAUSES: Record<string, DatabaseFailureCause> = {
  "28P01": "authentication_failed",
  "28000": "authentication_failed",
  "3D000": "database_not_found",
  "42501": "permission_denied",
  "42P01": "schema_missing",
  "57014": "query_timeout",
};

const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"]);

const nodeCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "");

const causeOf = (error: unknown, prismaCode: string | undefined, sqlState: string | undefined): DatabaseFailureCause => {
  const message = messageOf(error);
  if (prismaCode === "P2028") {
    if (message.startsWith("Unable to start a transaction in the given time")) {
      return "transaction_start_timeout";
    }
    return /timeout|expired/i.test(message) ? "transaction_timeout" : "transaction_api_error";
  }
  if (sqlState !== undefined && sqlState in SQLSTATE_CAUSES) {
    return SQLSTATE_CAUSES[sqlState] ?? "unexpected";
  }
  const code = nodeCode(error);
  if (code === "ETIMEDOUT" || /timeout exceeded when trying to connect|connection timeout/i.test(message)) {
    return "connect_timeout";
  }
  if (code !== undefined && UNREACHABLE.has(code)) {
    return "database_unreachable";
  }
  if ((code !== undefined && /CERT|TLS|SSL/.test(code)) || /self[- ]signed certificate|does not support SSL/i.test(message)) {
    return "tls_error";
  }
  if (/Query read timeout/i.test(message)) {
    return "query_timeout";
  }
  return "unexpected";
};

export const describeDatabaseFailure = (error: unknown): DatabaseFailure => {
  const prismaCode = prismaErrorCode(error);
  const sqlState = postgresErrorCode(error);
  const cause = causeOf(error, prismaCode, sqlState);
  return {
    cause,
    causeText: TEXTS[cause],
    ...(prismaCode !== undefined ? { prismaCode } : {}),
    ...(sqlState !== undefined ? { sqlState } : {}),
  };
};
