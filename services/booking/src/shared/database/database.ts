import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { describeError, type Logger } from "../../logging/logger.js";
import { buildPoolConfig, type PoolOptions } from "./pool-config.js";

export type { DatabaseSslMode } from "./database-url.js";
export { buildPoolConfig };
export type DatabaseOptions = PoolOptions;

export type Database = {
  prisma: PrismaClient;
  /**
   * Lightweight availability check (`SELECT 1`) through the shared pool with
   * its own driver-level timeout. On timeout pg fails the query and the pool
   * destroys that connection, so the next check opens a fresh one.
   */
  ping: (timeoutMs: number) => Promise<void>;
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

  const ping = async (timeoutMs: number): Promise<void> => {
    // pg 8.x honours a per-query `query_timeout` (lib/client.js), but
    // @types/pg's QueryConfig does not declare it; a non-literal object keeps
    // the call type-safe without an assertion. Covered by readiness tests.
    const readinessQuery = { text: "SELECT 1", query_timeout: timeoutMs };
    await pool.query(readinessQuery);
  };

  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        await prisma.$disconnect();
      } finally {
        // The adapter does not own this pool; end it even if $disconnect fails.
        await pool.end();
      }
    })();
    return closing;
  };

  return { prisma, ping, close };
};
