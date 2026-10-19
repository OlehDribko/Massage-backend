import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { describeError, type Logger } from "../../logging/logger.js";

export type DatabaseSslMode = "disable" | "verify-full";

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
 * Builds the pg pool config from a postgres:// URL.
 *
 * The URL is parsed here instead of being passed as `connectionString`: pg
 * lets URL parameters (sslmode=disable / no-verify, sslrootcert, ...) override
 * the explicit config, which could silently weaken TLS. TLS is therefore taken
 * only from `sslMode`; ssl-related URL parameters are ignored.
 */
export const buildPoolConfig = (options: DatabaseOptions): pg.PoolConfig => {
  const url = new URL(options.url);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ...(database !== "" ? { database } : {}),
    ssl: options.sslMode === "verify-full" ? { rejectUnauthorized: true } : false,
    // SCRAM channel binding (e.g. Neon's channel_binding=require); TLS only.
    enableChannelBinding:
      options.sslMode === "verify-full" &&
      url.searchParams.get("channel_binding") === "require",
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
