/**
 * Shared auth-gateway copy and contracts (Task C).
 *
 * The sign-in failure wording below is verbatim from packet 06 and MUST stay
 * identical whether or not the email exists — it is the account-enumeration
 * guard. There is intentionally no "forgot password" copy: no
 * fully-implemented recovery exists in-repo, so the link is omitted entirely.
 */

/** Generic sign-in failure — same wording whether or not the email exists. */
export const SIGNIN_GENERIC_ERROR =
  "We couldn't sign you in. Check your email and password and try again.";

/** Syntax-only email check for the gateway email stage (never an existence probe). */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Canonical `/auth` entry modes. The lead integrator wires routes to these. */
export type AuthGatewayMode = "email" | "signin" | "signup";
