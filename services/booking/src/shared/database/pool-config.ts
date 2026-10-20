import type pg from "pg";
import { parseDatabaseUrl, type DatabaseSslMode } from "./database-url.js";

export type PoolOptions = {
  url: string;
  /**
   * verify-full: TLS with certificate and hostname verification (default).
   * disable: plain TCP, only for local databases (e.g. Docker Compose).
   */
  sslMode: DatabaseSslMode;
  poolMax: number;
  connectTimeoutMs: number;
  /**
   * Client-side limit for every query sent through the pool (incl. Prisma).
   * On expiry pg fails the query; the pool then discards the client and
   * destroys its socket, so a hung connection is not reused.
   */
  queryTimeoutMs: number;
};

/**
 * Builds the pg pool config. The URL is parsed by parseDatabaseUrl (allow-listed
 * parameters only) and never passed to pg as `connectionString`: pg would let
 * URL parameters override the explicit TLS settings. TLS comes only from sslMode.
 * No Prisma import here, so the migration runner can use it too.
 */
export const buildPoolConfig = (options: PoolOptions): pg.PoolConfig => {
  const parsed = parseDatabaseUrl(options.url, options.sslMode);
  if (!parsed.ok) {
    // Config validation rejects such URLs at start-up; this is a safety net.
    // The message names only the rule, never parts of the URL.
    throw new Error(`database URL ${parsed.error}`);
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
    query_timeout: options.queryTimeoutMs,
    // TCP keepalive lets the OS detect a silently dropped peer on idle sockets.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
};
