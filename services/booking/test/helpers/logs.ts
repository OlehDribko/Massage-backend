import { z } from "zod";
import { createLogger, type Logger } from "../../src/logging/logger.js";

export const logEntrySchema = z.looseObject({
  level: z.string(),
  msg: z.string().optional(),
});

export type LogEntry = z.infer<typeof logEntrySchema>;

export const parseLogLine = (line: string): LogEntry | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const result = logEntrySchema.safeParse(parsed);
  return result.success ? result.data : undefined;
};

export type CapturedLogs = {
  logger: Logger;
  raw: () => string;
  entries: () => LogEntry[];
};

/** Logger writing JSON lines into memory instead of stdout. */
export const createCapturingLogger = (): CapturedLogs => {
  const lines: string[] = [];
  const logger = createLogger(
    { level: "debug" },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );

  return {
    logger,
    raw: () => lines.join(""),
    entries: () =>
      lines.flatMap((line) => {
        const entry = parseLogLine(line);
        return entry === undefined ? [] : [entry];
      }),
  };
};
