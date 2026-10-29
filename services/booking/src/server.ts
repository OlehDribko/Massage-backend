import { createApplication } from "./bootstrap.js";
import { loadConfig } from "./config/config.js";
import { createShutdownState, runHttpServer } from "./lifecycle/http-server.js";
import { createLogger } from "./logging/logger.js";
import { createDatabase } from "./shared/database/database.js";

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
    },
    "starting booking service",
  );

  const app = createApplication({
    config,
    logger,
    database,
    isShuttingDown: shutdownState.isShuttingDown,
  });

  runHttpServer({
    app,
    port: config.port,
    host: "0.0.0.0",
    logger,
    shutdownState,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    onClose: () => database.close(),
  });
};

main();
