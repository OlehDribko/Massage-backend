import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

/**
 * Creates the Prisma client. Construction does not open a connection; the
 * first query does. The URL comes from validated config, not process.env.
 */
export const createPrismaClient = (databaseUrl: string): PrismaClient => {
  const adapter = new PrismaNeon({
    connectionString: databaseUrl,
  });

  return new PrismaClient({
    adapter,
  });
};
