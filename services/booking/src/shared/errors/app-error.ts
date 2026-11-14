type AppErrorOptions = {
  code?: string;
  details?: Record<string, unknown>;
  /** The original failure, kept for logs only (never sent to the client). */
  cause?: unknown;
};

export class AppError extends Error {
  statusCode: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);

    this.statusCode = statusCode;
    if (options.code !== undefined) {
      this.code = options.code;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}
