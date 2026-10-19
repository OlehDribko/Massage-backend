// Test-only process: connects with the production pool config (buildPoolConfig)
// and prints the outcome as one JSON line. Run with NODE_EXTRA_CA_CERTS to
// trust the test CA; Node reads that variable only at process start.
import pg from "pg";
import { z } from "zod";
import { buildPoolConfig } from "../../src/shared/database/database.js";

const env = z
  .object({
    TEST_DATABASE_URL: z.string(),
    TEST_SSL_MODE: z.enum(["verify-full", "disable"]),
  })
  .parse(process.env);

const config = buildPoolConfig({
  url: env.TEST_DATABASE_URL,
  sslMode: env.TEST_SSL_MODE,
  poolMax: 1,
  connectTimeoutMs: 5_000,
  queryTimeoutMs: 5_000,
});

const client = new pg.Client(config);

const errorCode = (error: unknown): string => {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.message : "unknown";
};

client.on("error", () => undefined);

try {
  await client.connect();
  console.log(JSON.stringify({ result: "connected" }));
} catch (error) {
  console.log(JSON.stringify({ result: "error", code: errorCode(error) }));
} finally {
  await client.end().catch(() => undefined);
}
