import { createServer, type RequestListener, type Server } from "node:http";
import { describeError, type Logger } from "../logging/logger.js";

export type ShutdownState = {
  isShuttingDown: () => boolean;
  /** Returns false if shutdown was already started. */
  begin: () => boolean;
};

export const createShutdownState = (): ShutdownState => {
  let shuttingDown = false;
  return {
    isShuttingDown: () => shuttingDown,
    begin: () => {
      if (shuttingDown) {
        return false;
      }
      shuttingDown = true;
      return true;
    },
  };
};

export type RunHttpServerOptions = {
  app: RequestListener;
  port: number;
  host: string;
  logger: Logger;
  shutdownState: ShutdownState;
  shutdownTimeoutMs: number;
  /** Releases resources (e.g. Prisma) after the HTTP server has closed. */
  onClose: () => Promise<void>;
};

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] satisfies NodeJS.Signals[];

/**
 * Starts the HTTP server and installs SIGTERM/SIGINT handling:
 * 1. mark the process as shutting down (readiness turns 503);
 * 2. stop accepting new connections and let active requests finish;
 * 3. close resources via onClose;
 * 4. exit with 0, or with 1 on timeout / failure.
 * A repeated signal is logged and ignored; the timeout still applies.
 */
export const runHttpServer = ({
  app,
  port,
  host,
  logger,
  shutdownState,
  shutdownTimeoutMs,
  onClose,
}: RunHttpServerOptions): Server => {
  const server = createServer(app);
  let finishing = false;

  const finish = async (exitCode: number): Promise<void> => {
    if (finishing) {
      return;
    }
    finishing = true;

    let code = exitCode;
    try {
      await onClose();
    } catch (error) {
      logger.error({ error: describeError(error) }, "failed to release resources");
      code = 1;
    }

    logger.info({ exitCode: code }, "process exiting");
    logger.flush();
    // All work is done at this point: the server is closed (or never started)
    // and resources are released, so exiting does not cut off requests or logs.
    process.exit(code);
  };

  // Keep-alive sockets that become idle during shutdown are closed promptly
  // instead of holding server.close() until they time out.
  server.on("request", (_req, res) => {
    res.on("finish", () => {
      if (shutdownState.isShuttingDown()) {
        setImmediate(() => server.closeIdleConnections());
      }
    });
  });

  server.on("error", (error) => {
    logger.fatal(
      { error: describeError(error), port },
      server.listening ? "HTTP server error" : "failed to start HTTP server",
    );
    void finish(1);
  });

  const shutdown = (signal: NodeJS.Signals) => {
    if (!shutdownState.begin()) {
      logger.warn({ signal }, "shutdown already in progress");
      return;
    }

    logger.info({ signal, timeoutMs: shutdownTimeoutMs }, "shutdown started");

    const timer = setTimeout(() => {
      logger.error(
        { timeoutMs: shutdownTimeoutMs },
        "shutdown timed out; closing remaining connections",
      );
      server.closeAllConnections();
      void finish(1);
    }, shutdownTimeoutMs);

    // Stops accepting connections; the callback runs once active ones end.
    server.close((error) => {
      clearTimeout(timer);
      if (error) {
        logger.error({ error: describeError(error) }, "HTTP server close failed");
        void finish(1);
        return;
      }
      logger.info("HTTP server closed");
      void finish(0);
    });
    server.closeIdleConnections();
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => shutdown(signal));
  }

  server.listen(port, host, () => {
    const address = server.address();
    const boundPort =
      address !== null && typeof address === "object" ? address.port : port;
    logger.info({ host, port: boundPort }, "server listening");
  });

  return server;
};
