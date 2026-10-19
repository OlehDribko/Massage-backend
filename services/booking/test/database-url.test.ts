import { describe, expect, it } from "vitest";
import { parseDatabaseUrl, type ParsedDatabaseUrl } from "../src/shared/database/database-url.js";

const ok = (url: string, sslMode: "verify-full" | "disable" = "verify-full"): ParsedDatabaseUrl => {
  const result = parseDatabaseUrl(url, sslMode);
  if (!result.ok) {
    throw new Error(`expected a valid URL, got: ${result.error}`);
  }
  return result.value;
};

const error = (url: string, sslMode: "verify-full" | "disable" = "verify-full"): string => {
  const result = parseDatabaseUrl(url, sslMode);
  if (result.ok) {
    throw new Error("expected an invalid URL");
  }
  return result.error;
};

describe("parseDatabaseUrl", () => {
  it("decodes percent-encoded credentials and database names", () => {
    // Password: p@ss:w/rd#?%+ (every reserved character percent-encoded).
    const url = ok(
      "postgresql://app%2Duser:p%40ss%3Aw%2Frd%23%3F%25%2B@db.example.invalid:6543/my%20db",
    );
    expect(url).toEqual({
      host: "db.example.invalid",
      port: 6543,
      user: "app-user",
      password: "p@ss:w/rd#?%+",
      database: "my db",
      preferChannelBinding: false,
    });
  });

  it("keeps a literal plus sign (userinfo is not form-encoded)", () => {
    expect(ok("postgres://u:a+b@localhost/db").password).toBe("a+b");
  });

  it("defaults the port and allows an empty password or database", () => {
    expect(ok("postgres://u@localhost")).toEqual({
      host: "localhost",
      port: 5432,
      user: "u",
      password: "",
      database: undefined,
      preferChannelBinding: false,
    });
  });

  it("strips the brackets of IPv6 hosts", () => {
    expect(ok("postgresql://u:p@[::1]:5433/db").host).toBe("::1");
  });

  it.each([
    ["not a url", "is not a valid URL"],
    ["mysql://u:p@h/db", "must be a postgres:// or postgresql:// URL"],
    ["postgresql://:p@h/db", "must include a user name"],
    ["postgresql://u:%zz@h/db", "contains invalid percent-encoding"],
  ])("rejects %j", (url, message) => {
    expect(error(url)).toBe(message);
  });

  it("never echoes credentials in error messages", () => {
    const message = error("postgresql://user:SECRET%zz@h/db");
    expect(message).not.toContain("SECRET");
    expect(error("postgresql://user:SECRET@h/db?sslmode=no-verify")).not.toContain("SECRET");
  });

  it.each([
    "sslrootcert=/tmp/ca.pem",
    "sslcert=/tmp/c.pem",
    "sslkey=/tmp/k.pem",
    "ssl=true",
    "sslnegotiation=direct",
    "gssencmode=disable",
    "options=-c%20search_path%3Devil",
    "target_session_attrs=any",
    "schema=booking",
    "connection_limit=5",
  ])("rejects unsupported parameter %s instead of ignoring it", (query) => {
    const name = query.split("=")[0] ?? "";
    expect(error(`postgresql://u:p@h/db?${query}`)).toBe(`parameter "${name}" is not supported`);
  });

  it("rejects repeated parameters", () => {
    expect(error("postgresql://u:p@h/db?sslmode=require&sslmode=disable")).toBe(
      'parameter "sslmode" is repeated',
    );
  });

  describe("sslmode", () => {
    it.each(["require", "verify-ca", "verify-full"])(
      "accepts sslmode=%s with DATABASE_SSL_MODE=verify-full (verification is still full)",
      (mode) => {
        expect(ok(`postgresql://u:p@h/db?sslmode=${mode}`).host).toBe("h");
      },
    );

    it.each(["disable", "allow", "prefer", "no-verify"])(
      "rejects weaker sslmode=%s with DATABASE_SSL_MODE=verify-full",
      (mode) => {
        expect(error(`postgresql://u:p@h/db?sslmode=${mode}`)).toMatch(
          /^parameter "sslmode" conflicts with DATABASE_SSL_MODE=verify-full/,
        );
      },
    );

    it("rejects a URL that demands TLS while DATABASE_SSL_MODE=disable", () => {
      expect(error("postgresql://u:p@h/db?sslmode=require", "disable")).toMatch(
        /^parameter "sslmode" conflicts with DATABASE_SSL_MODE=disable/,
      );
      expect(ok("postgresql://u:p@h/db?sslmode=disable", "disable").host).toBe("h");
    });
  });

  describe("channel_binding", () => {
    it("rejects require because node-postgres cannot enforce it", () => {
      expect(error("postgresql://u:p@h/db?sslmode=require&channel_binding=require")).toMatch(
        /cannot be enforced/,
      );
    });

    it("maps prefer to opportunistic SCRAM-SHA-256-PLUS over TLS only", () => {
      expect(ok("postgresql://u:p@h/db?channel_binding=prefer").preferChannelBinding).toBe(true);
      expect(
        ok("postgresql://u:p@h/db?channel_binding=prefer", "disable").preferChannelBinding,
      ).toBe(false);
      expect(ok("postgresql://u:p@h/db?channel_binding=disable").preferChannelBinding).toBe(false);
    });
  });
});
