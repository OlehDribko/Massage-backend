import { describe, expect, it } from "vitest";
import { describeDatabaseFailure } from "../src/admin/database-failure.js";
import { Prisma } from "../src/generated/prisma/client.js";

const withCode = (message: string, code: string) => Object.assign(new Error(message), { code });
const prismaError = (message: string, code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "test", ...(meta !== undefined ? { meta } : {}) });

describe("describeDatabaseFailure", () => {
  it("names the P2028 variants: start timeout, expired transaction, other transaction API errors", () => {
    expect(describeDatabaseFailure(prismaError("Unable to start a transaction in the given time.", "P2028"))).toEqual({
      cause: "transaction_start_timeout",
      causeText: "the transaction could not start in time (no free connection)",
      prismaCode: "P2028",
    });
    expect(
      describeDatabaseFailure(prismaError("Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms", "P2028")),
    ).toMatchObject({ cause: "transaction_timeout", prismaCode: "P2028" });
    expect(describeDatabaseFailure(prismaError("Transaction not found.", "P2028"))).toMatchObject({ cause: "transaction_api_error" });
  });

  it("maps driver and PostgreSQL errors to safe causes", () => {
    expect(describeDatabaseFailure(new Error("timeout exceeded when trying to connect"))).toMatchObject({ cause: "connect_timeout" });
    expect(describeDatabaseFailure(withCode("connect ECONNREFUSED 10.0.0.1:5432", "ECONNREFUSED"))).toMatchObject({ cause: "database_unreachable" });
    expect(describeDatabaseFailure(withCode("getaddrinfo ENOTFOUND ep-secret-host", "ENOTFOUND"))).toMatchObject({ cause: "database_unreachable" });
    expect(describeDatabaseFailure(withCode("self-signed certificate in certificate chain", "SELF_SIGNED_CERT_IN_CHAIN"))).toMatchObject({ cause: "tls_error" });
    expect(describeDatabaseFailure(withCode('password authentication failed for user "booking_app"', "28P01"))).toEqual({
      cause: "authentication_failed",
      causeText: "the database rejected the credentials",
      sqlState: "28P01",
    });
    expect(describeDatabaseFailure(prismaError("denied", "P2010", { driverAdapterError: { cause: { originalCode: "42501" } } }))).toMatchObject({
      cause: "permission_denied",
      prismaCode: "P2010",
      sqlState: "42501",
    });
  });

  it("never copies the original message", () => {
    const failure = describeDatabaseFailure(new Error("postgresql://user:db-secret-value@host/db broke"));
    expect(failure).toEqual({ cause: "unexpected", causeText: "unexpected error" });
    expect(JSON.stringify(describeDatabaseFailure(withCode("getaddrinfo ENOTFOUND ep-secret-host", "ENOTFOUND")))).not.toContain("secret");
    expect(describeDatabaseFailure("not an error")).toEqual({ cause: "unexpected", causeText: "unexpected error" });
  });
});
