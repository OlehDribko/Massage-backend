// Test-only process: logs three lines with the production logger while the
// libuv threadpool is busy (run with UV_THREADPOOL_SIZE=1), then exits the way
// runHttpServer does. With an asynchronous stdout destination the first line
// is still queued for the threadpool when process.exit() flushes the rest.
import { pbkdf2 } from "node:crypto";
import { createLogger } from "../../src/logging/logger.js";

const logger = createLogger({ level: "info" });

pbkdf2("busy", "threadpool", 1_000_000, 64, "sha512", () => undefined);

logger.info("first line");
logger.info("second line");
logger.info({ exitCode: 0 }, "process exiting");
logger.flush();
process.exit(0);
