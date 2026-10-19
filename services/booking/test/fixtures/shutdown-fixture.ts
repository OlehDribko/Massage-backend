// Test-only process for shutdown tests. It mounts a /slow route on its own
// wrapper app (never on the production app) and uses the real runHttpServer.
import express from "express";
import { z } from "zod";
import { createApp } from "../../src/app.js";
import { createShutdownState, runHttpServer } from "../../src/lifecycle/http-server.js";
import { createLogger } from "../../src/logging/logger.js";

const fixtureEnv = z
  .object({
    FIXTURE_MODE: z.enum(["complete", "hang"]),
    // "hang": the cleanup dependency (stand-in for closing the DB) never settles.
    FIXTURE_CLEANUP: z.enum(["resolve", "hang"]).default("resolve"),
    SHUTDOWN_TIMEOUT_MS: z.string().regex(/^\d+$/).transform(Number),
  })
  .parse(process.env);

const logger = createLogger({ level: "info" });
const shutdownState = createShutdownState();

let signalled = false;
const waitingResponses: (() => void)[] = [];

const app = express();

app.get("/slow", (_req, res) => {
  logger.info("slow request started");

  if (fixtureEnv.FIXTURE_MODE === "hang") {
    return;
  }

  // Completes only after SIGTERM was received, so the request is guaranteed
  // to be in flight while shutdown is running.
  const respond = () => {
    setImmediate(() => {
      res.status(200).json({ completed: true });
      logger.info("slow request finished");
    });
  };

  if (signalled) {
    respond();
  } else {
    waitingResponses.push(respond);
  }
});

app.use(
  createApp({
    logger,
    isShuttingDown: shutdownState.isShuttingDown,
    probeReadiness: () => Promise.resolve("ready"),
    appVersion: undefined,
    corsOrigin: undefined,
    legacyUserRouter: undefined,
  }),
);

runHttpServer({
  app,
  port: 0,
  host: "127.0.0.1",
  logger,
  shutdownState,
  shutdownTimeoutMs: fixtureEnv.SHUTDOWN_TIMEOUT_MS,
  onClose: () => {
    if (fixtureEnv.FIXTURE_CLEANUP === "hang") {
      logger.info("fixture cleanup started and will never finish");
      // An active handle, like a stuck database socket, keeps the event loop alive.
      setInterval(() => undefined, 1_000);
      return new Promise<void>(() => undefined);
    }
    logger.info("fixture resources released");
    return Promise.resolve();
  },
});

// Registered after runHttpServer, so the server's shutdown handler runs first.
process.on("SIGTERM", () => {
  signalled = true;
  for (const respond of waitingResponses.splice(0)) {
    respond();
  }
});
