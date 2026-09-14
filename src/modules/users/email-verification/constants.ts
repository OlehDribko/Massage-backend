/**
 * Anti-spam window between verification email sends
 * (first auto-send claim + /resend-verification).
 */
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;

/** @deprecated alias — use EMAIL_VERIFICATION_RESEND_COOLDOWN_MS */
export const EMAIL_VERIFICATION_COOLDOWN_MS =
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS;
