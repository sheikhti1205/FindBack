/**
 * Shared auth-gateway copy and contracts (Task C).
 *
 * The sign-in failure wording below is verbatim from packet 06 and MUST stay
 * identical whether or not the email exists — it is the account-enumeration
 * guard. Password recovery follows the same rule: the reset request always
 * shows the inbox message, so existence is never leaked.
 */

/** Generic sign-in failure — same wording whether or not the email exists. */
export const SIGNIN_GENERIC_ERROR =
  "We couldn't sign you in. Check your email and password and try again.";

/** Reset request outcome — identical whether or not the email exists. */
export const PASSWORD_RESET_SENT =
  "If an account uses this email, a reset link is on its way. Check your inbox.";

/** Recovery link states. */
export const RECOVERY_INVALID_LINK = "This password-reset link is invalid or expired. Request a new one.";
export const RECOVERY_SUCCESS = "Your password is updated. You're signed in.";

/** Syntax-only email check for the gateway email stage (never an existence probe). */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Canonical `/auth` entry modes. The lead integrator wires routes to these. */
export type AuthGatewayMode = "email" | "signin" | "signup";
