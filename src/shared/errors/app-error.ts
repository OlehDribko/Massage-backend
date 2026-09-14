type AppErrorOptions = {
  code?: string;
  details?: Record<string, unknown>;
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
    super(message);

    this.statusCode = statusCode;
    if (options.code !== undefined) {
      this.code = options.code;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}
