import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { parseLogLine, type LogEntry } from "./logs.js";

const bookingDir = fileURLToPath(new URL("../..", import.meta.url));

export type ExitResult = { code: number | null; signal: NodeJS.Signals | null };

export type RunningChild = {
  process: ChildProcess;
  entries: () => LogEntry[];
  output: () => string;
  waitForLog: (predicate: (entry: LogEntry) => boolean, timeoutMs?: number) => Promise<LogEntry>;
  exited: Promise<ExitResult>;
};

const running = new Set<ChildProcess>();

/**
 * Runs a TypeScript file in a separate Node.js process via tsx.
 * Only the given variables (plus PATH) are passed; no .env file is read.
 */
export const startTsProcess = (
  relativeFile: string,
  env: Record<string, string>,
  args: string[] = [],
): RunningChild => {
  const child = spawn(process.execPath, ["--import", "tsx", relativeFile, ...args], {
    cwd: bookingDir,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);

  const entries: LogEntry[] = [];
  let output = "";
  let pending = "";
  const listeners = new Set<() => void>();

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const entry = parseLogLine(line);
      if (entry !== undefined) {
        entries.push(entry);
      }
    }
    for (const listener of listeners) {
      listener();
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    output += chunk;
  });

  // "close" (not "exit"): fires only after stdout/stderr have ended, so every
  // line the process wrote is already in entries()/output().
  const exited = new Promise<ExitResult>((resolve) => {
    child.once("close", (code, signal) => {
      running.delete(child);
      resolve({ code, signal });
      for (const listener of listeners) {
        listener();
      }
    });
  });

  const waitForLog = (
    predicate: (entry: LogEntry) => boolean,
    timeoutMs = 10_000,
  ): Promise<LogEntry> =>
    new Promise<LogEntry>((resolve, reject) => {
      const check = () => {
        const found = entries.find(predicate);
        if (found !== undefined) {
          cleanup();
          resolve(found);
          return;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          cleanup();
          reject(new Error(`process exited before expected log; output:\n${output}`));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for log; output:\n${output}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      listeners.add(check);
      check();
    });

  return {
    process: child,
    entries: () => [...entries],
    output: () => output,
    waitForLog,
    exited,
  };
};

/** Kills any child process a test left running. */
export const killRunningChildren = async (): Promise<void> => {
  const waits = [...running].map(
    (child) =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      }),
  );
  await Promise.all(waits);
};

export const getFreePort = (): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });

export const hasMessage =
  (message: string) =>
  (entry: LogEntry): boolean =>
    entry.msg === message;
