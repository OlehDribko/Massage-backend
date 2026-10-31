import { createApplication } from "./bootstrap.js";
import { loadConfig } from "./config/config.js";
import { createShutdownState, runHttpServer } from "./lifecycle/http-server.js";
import { createLogger, type Logger } from "./logging/logger.js";
import { createBrevoProvider } from "./notifications/brevo-provider.js";
import { DEFAULT_TUNING, tuningErrors, type NotificationConfig } from "./notifications/config.js";
import { createDispatcher, type Dispatcher } from "./notifications/dispatcher.js";
import { newWorkerId, nextWorkAt } from "./notifications/store.js";
import { createWorker } from "./notifications/worker.js";
import { createDatabase, type Database } from "./shared/database/database.js";

/**
 * Booking emails inside this process: no polling loop. Passes run after
 * booking writes, once at start-up (work left by a stopped process) and at
 * the time of the next concrete retry (docs/notifications.md).
 */
const createNotifications = (config: NotificationConfig, database: Database, logger: Logger): Dispatcher | undefined => {
  if (!config.enabled) {
    return undefined;
  }
  const worker = createWorker({
    prisma: database.prisma,
    provider: createBrevoProvider({
      apiKey: config.brevo.apiKey,
      senderName: config.brevo.senderName,
      senderEmail: config.brevo.senderEmail,
      requestTimeoutMs: DEFAULT_TUNING.requestTimeoutMs,
    }),
    logger,
    workerId: newWorkerId(),
    studioEmail: config.studioEmail,
    recipientAllowlist: config.recipientAllowlist,
    tuning: DEFAULT_TUNING,
  });
  return createDispatcher({
    tick: worker.tick,
    nextWorkAt: () => nextWorkAt(database.prisma),
    stopWorker: worker.stop,
    logger,
  });
};

// Production entry point. Reads only process.env; no .env file is loaded here
// (the dev script passes the root .env via Node's --env-file-if-exists).
const main = () => {
  const loaded = loadConfig(process.env);

  if (!loaded.ok) {
    // Errors name variables and rules only, never values.
    createLogger({ level: "info" }).fatal(
      { errors: loaded.errors },
      "invalid configuration",
    );
    process.exitCode = 1;
    return;
  }

  const { config } = loaded;
  const logger = createLogger({ level: config.logLevel, appVersion: config.appVersion });
  const tuningProblems = tuningErrors(DEFAULT_TUNING);
  if (config.notifications.enabled && tuningProblems.length > 0) {
    logger.fatal({ errors: tuningProblems }, "invalid notifications tuning");
    process.exitCode = 1;
    return;
  }
  const database = createDatabase(
    {
      url: config.databaseUrl,
      sslMode: config.databaseSslMode,
      poolMax: config.databasePoolMax,
      connectTimeoutMs: config.databaseConnectTimeoutMs,
      queryTimeoutMs: config.databaseQueryTimeoutMs,
    },
    logger,
  );
  const shutdownState = createShutdownState();
  const notifications = createNotifications(config.notifications, database, logger);

  logger.info(
    {
      nodeEnv: config.nodeEnv,
      port: config.port,
      authEnabled: config.firebase !== undefined,
      authRequired: config.authRequired,
      authEmulator: config.firebase?.credentials.kind === "emulator",
      marketingEnabled: config.marketing !== undefined,
      corsEnabled: config.corsOrigin !== undefined,
      databaseSslMode: config.databaseSslMode,
      databasePoolMax: config.databasePoolMax,
      notificationsEnabled: config.notifications.enabled,
      notificationsEnvironment: config.notifications.enabled ? config.notifications.environment : null,
      notificationsAllowlistSize: config.notifications.enabled ? (config.notifications.recipientAllowlist?.size ?? null) : null,
    },
    "starting booking service",
  );

  const app = createApplication({
    config,
    logger,
    database,
    isShuttingDown: shutdownState.isShuttingDown,
    notifications,
  });

  runHttpServer({
    app,
    port: config.port,
    host: "0.0.0.0",
    logger,
    shutdownState,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    // The email in flight (if any) is finished before the pool closes; the
    // shutdown deadline still applies (an unfinished attempt resumes after
    // the next start, with the same idempotency key).
    onClose: async () => {
      await notifications?.stop();
      await database.close();
    },
  });

  // Start-up recovery: work left by a stopped process (unplanned events,
  // pending retries, expired leases).
  notifications?.start();
};

main();
