import { createLogger } from "../logging/logger.js";
import { createDatabase } from "../shared/database/database.js";
import { createBrevoProvider } from "./brevo-provider.js";
import { DEFAULT_TUNING, loadNotificationConfig, tuningErrors } from "./config.js";
import { newWorkerId } from "./store.js";
import { createWorker } from "./worker.js";

// Entry point of the notifications worker: `node dist/notifications/main.js`
// (npm run notifications:worker). A separate process: the HTTP API never
// starts it. Reads only process.env.
const main = async (): Promise<number> => {
  const loaded = loadNotificationConfig(process.env);
  if (!loaded.ok) {
    createLogger({ level: "info" }).fatal({ errors: loaded.errors }, "invalid notifications configuration");
    return 1;
  }
  const { config } = loaded;
  const logger = createLogger({ level: config.logLevel });
  if (!config.enabled) {
    logger.info("booking notifications are disabled (ENABLE_BOOKING_NOTIFICATIONS is not true); nothing to do");
    return 0;
  }
  const problems = tuningErrors(DEFAULT_TUNING);
  if (problems.length > 0) {
    logger.fatal({ errors: problems }, "invalid notifications tuning");
    return 1;
  }

  const database = createDatabase(
    {
      url: config.database.url,
      sslMode: config.database.sslMode,
      poolMax: config.database.poolMax,
      connectTimeoutMs: 5_000,
      queryTimeoutMs: 30_000,
    },
    logger,
  );
  const workerId = newWorkerId();
  const worker = createWorker({
    prisma: database.prisma,
    provider: createBrevoProvider({
      apiKey: config.brevo.apiKey,
      senderName: config.brevo.senderName,
      senderEmail: config.brevo.senderEmail,
      requestTimeoutMs: DEFAULT_TUNING.requestTimeoutMs,
    }),
    logger,
    workerId,
    studioEmail: config.studioEmail,
    recipientAllowlist: config.recipientAllowlist,
    tuning: DEFAULT_TUNING,
  });

  logger.info(
    { workerId, environment: config.environment, recipientAllowlist: config.recipientAllowlist?.size ?? null },
    "starting notifications worker",
  );

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "stopping notifications worker");
    void worker.stop();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await worker.run();
  await database.close();
  return 0;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    createLogger({ level: "info" }).fatal(
      { error: error instanceof Error ? error.name : "unknown" },
      "notifications worker crashed",
    );
    process.exitCode = 1;
  },
);
