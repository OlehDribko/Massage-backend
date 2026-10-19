import { isIP } from "node:net";

export type DatabaseSslMode = "disable" | "verify-full";

export type ParsedDatabaseUrl = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string | undefined;
  /** SCRAM-SHA-256-PLUS when the server offers it (pg cannot enforce it). */
  preferChannelBinding: boolean;
};

export type DatabaseUrlResult =
  | { ok: true; value: ParsedDatabaseUrl }
  | { ok: false; error: string };

/**
 * Query parameters this service understands. Anything else is rejected rather
 * than ignored, because libpq-style parameters often affect security
 * (sslrootcert, sslcert, gssencmode, options, ...).
 *
 * - sslmode: TLS is configured by DATABASE_SSL_MODE. A URL value is accepted
 *   only if it does not ask for less than that setting
 *   (verify-full: require | verify-ca | verify-full; disable: disable).
 * - channel_binding: only "prefer" and "disable". node-postgres uses
 *   SCRAM-SHA-256-PLUS when the server offers it but cannot refuse a server
 *   that does not, so libpq's "require" cannot be honoured and is rejected.
 */
const SSLMODE_ALLOWED: Record<DatabaseSslMode, readonly string[]> = {
  "verify-full": ["require", "verify-ca", "verify-full"],
  disable: ["disable"],
};

const CHANNEL_BINDING_ALLOWED = ["prefer", "disable"];

const decode = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

// Error messages name the problem, never the URL or its parts.
export const parseDatabaseUrl = (
  url: string,
  sslMode: DatabaseSslMode,
): DatabaseUrlResult => {
  if (!URL.canParse(url)) {
    return { ok: false, error: "is not a valid URL" };
  }
  const parsed = new URL(url);

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { ok: false, error: "must be a postgres:// or postgresql:// URL" };
  }

  // WHATWG URL keeps IPv6 hosts in brackets; pg expects the bare address.
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host === "") {
    return { ok: false, error: "must include a host" };
  }
  if (host.startsWith("/") || (isIP(host) === 0 && !/^[A-Za-z0-9.-]+$/.test(host))) {
    return { ok: false, error: "host must be a hostname or an IP address" };
  }

  const user = decode(parsed.username);
  const password = decode(parsed.password);
  const database = decode(parsed.pathname.replace(/^\//, ""));
  if (user === undefined || password === undefined || database === undefined) {
    return { ok: false, error: "contains invalid percent-encoding" };
  }
  if (user === "") {
    return { ok: false, error: "must include a user name" };
  }

  let preferChannelBinding = false;
  const seen = new Set<string>();

  for (const [name, value] of parsed.searchParams) {
    if (seen.has(name)) {
      return { ok: false, error: `parameter "${name}" is repeated` };
    }
    seen.add(name);

    if (name === "sslmode") {
      if (!SSLMODE_ALLOWED[sslMode].includes(value)) {
        return {
          ok: false,
          error: `parameter "sslmode" conflicts with DATABASE_SSL_MODE=${sslMode} (allowed: ${SSLMODE_ALLOWED[sslMode].join(", ")})`,
        };
      }
      continue;
    }

    if (name === "channel_binding") {
      if (!CHANNEL_BINDING_ALLOWED.includes(value)) {
        return {
          ok: false,
          error:
            'parameter "channel_binding" supports only prefer or disable; "require" cannot be enforced by node-postgres',
        };
      }
      preferChannelBinding = value === "prefer" && sslMode === "verify-full";
      continue;
    }

    return { ok: false, error: `parameter "${name}" is not supported` };
  }

  return {
    ok: true,
    value: {
      host,
      port: parsed.port === "" ? 5432 : Number(parsed.port),
      user,
      password,
      database: database === "" ? undefined : database,
      preferChannelBinding,
    },
  };
};
