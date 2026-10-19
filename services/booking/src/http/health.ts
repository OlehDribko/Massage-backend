import { Router } from "express";

export type ReadinessOutcome = "ready" | "unavailable" | "timeout";

/**
 * Runs the dependency check with a time limit.
 *
 * The timeout only bounds how long the HTTP request waits: the underlying
 * database query is NOT cancelled (the driver offers no cancellation here).
 * To avoid piling up hung queries, at most one check is in flight; concurrent
 * or later probes reuse it until it settles.
 */
export const createReadinessProbe = (
  check: () => Promise<unknown>,
  timeoutMs: number,
): (() => Promise<ReadinessOutcome>) => {
  let inFlight: Promise<boolean> | undefined;

  const runCheck = (): Promise<boolean> => {
    if (inFlight === undefined) {
      // Promise.resolve().then also turns a synchronous throw into "unavailable".
      const attempt = Promise.resolve()
        .then(check)
        .then(
          () => true,
          () => false,
        );
      inFlight = attempt;
      void attempt.finally(() => {
        if (inFlight === attempt) {
          inFlight = undefined;
        }
      });
    }
    return inFlight;
  };

  return async () => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    try {
      const result = await Promise.race([runCheck(), timeout]);
      if (result === "timeout") {
        return "timeout";
      }
      return result ? "ready" : "unavailable";
    } finally {
      clearTimeout(timer);
    }
  };
};

export type HealthDeps = {
  isShuttingDown: () => boolean;
  probeReadiness: () => Promise<ReadinessOutcome>;
  appVersion: string | undefined;
};

export const createHealthRouter = ({
  isShuttingDown,
  probeReadiness,
  appVersion,
}: HealthDeps): Router => {
  const router = Router();
  const versionField = appVersion !== undefined ? { version: appVersion } : {};

  // Liveness: the process is up and serving HTTP. No database or email access.
  router.get("/live", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Readiness: not shutting down and the database answers SELECT 1 in time.
  router.get("/ready", async (_req, res) => {
    if (isShuttingDown()) {
      res.status(503).json({ status: "unavailable", reason: "shutting_down" });
      return;
    }

    const outcome = await probeReadiness();

    if (outcome === "ready") {
      res.status(200).json({ status: "ready", ...versionField });
      return;
    }

    res.status(503).json({ status: "unavailable", reason: "database_unavailable" });
  });

  return router;
};
