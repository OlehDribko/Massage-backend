import { BrevoError, Brevo } from "@getbrevo/brevo";

export class EmailServiceError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
  ) {
    super(message);
    this.name = "EmailServiceError";
  }
}
export const mapBrevoError = (error: unknown): EmailServiceError => {
  if (error instanceof Brevo.UnauthorizedError) {
    return new EmailServiceError(
      "Brevo authorization failed. Check BREVO_API_KEY.",
      error,
    );
  }

  if (error instanceof Brevo.TooManyRequestsError) {
    return new EmailServiceError(
      "Brevo rate limit exceeded. Try again later.",
      error,
    );
  }

  if (error instanceof BrevoError) {
    return new EmailServiceError("Brevo email provider error.", error);
  }

  return new EmailServiceError("Unknown email service error.", error);
};
