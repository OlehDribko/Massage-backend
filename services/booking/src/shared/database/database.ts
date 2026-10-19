import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { describeError, type Logger } from "../../logging/logger.js";
import { parseDatabaseUrl, type DatabaseSslMode } from "./database-url.js";

export type { DatabaseSslMode };

export type DatabaseOptions = {
  url: string;
  /**
   * verify-full: TLS with certificate and hostname verification (default).
   * disable: plain TCP, only for local databases (e.g. Docker Compose).
   */
  sslMode: DatabaseSslMode;
  poolMax: number;
  connectTimeoutMs: number;
};

/**
 * Builds the pg pool config. The URL is parsed by parseDatabaseUrl (allow-listed
 * parameters only) and never passed to pg as `connectionString`: pg would let
 * URL parameters override the explicit TLS settings. TLS comes only from sslMode.
 */
export const buildPoolConfig = (options: DatabaseOptions): pg.PoolConfig => {
  const parsed = parseDatabaseUrl(options.url, options.sslMode);
  if (!parsed.ok) {
    // Config validation rejects such URLs at start-up; this is a safety net.
    throw new Error(`DATABASE_URL ${parsed.error}`);
  }
  const url = parsed.value;

  return {
    host: url.host,
    port: url.port,
    user: url.user,
    password: url.password,
    ...(url.database !== undefined ? { database: url.database } : {}),
    // Node verifies the chain against its CA store and the hostname (SNI is
    // set by pg for DNS names; IP addresses are checked against IP SANs).
    ssl: options.sslMode === "verify-full" ? { rejectUnauthorized: true } : false,
    enableChannelBinding: url.preferChannelBinding,
    max: options.poolMax,
    connectionTimeoutMillis: options.connectTimeoutMs,
    idleTimeoutMillis: 30_000,
  };
};

export type Database = {
  prisma: PrismaClient;
  /** Disconnects Prisma and ends the pool. Safe to call more than once. */
  close: () => Promise<void>;
};

/**
 * One pg pool per process, owned here (not by the adapter): construction does
 * not connect; connections are opened lazily by the first query.
 */
export const createDatabase = (options: DatabaseOptions, logger: Logger): Database => {
  const pool = new pg.Pool(buildPoolConfig(options));

  // Without a listener, an error on an idle client (e.g. the database
  // restarting) would be an unhandled 'error' event and crash the process.
  pool.on("error", (error) => {
    logger.warn({ error: describeError(error) }, "idle database connection error");
  });

  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool, {
      onConnectionError: (error) => {
        logger.warn({ error: describeError(error) }, "database connection error");
      },
    }),
  });

  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closing ??= (async () => {
      await prisma.$disconnect();
      await pool.end();
    })();
    return closing;
  };

  return { prisma, close };
};
