/**
 * W-E — Google sign-in failure-class taxonomy (single owner for consumer copy).
 *
 * Every Google failure the app can observe collapses onto ONE of these
 * stable classes. Consumer UI renders ONLY the copy below — never raw
 * exception text, never token/nonce material, never console-side identifiers.
 *
 * Native exception → class table (bridge: `GoogleAuthPlugin.kindFor`;
 * the plugin logs ONLY the exception class + kind + config hint via logcat):
 *
 * | native signal (logcat `exceptionClass=`)                  | class               |
 * |------------------------------------------------------------|---------------------|
 * | GetCredentialProviderConfigurationException                | setup_unavailable   |
 * | NoCredentialException                                      | no_account          |
 * | GetCredentialUnsupportedException                          | device_unsupported  |
 * | GetCredentialCancellationException / Interrupted           | cancelled_silent    |
 * | IOException in the cause chain (incl. network custom errs) | network             |
 * | token/code minted but Supabase rejects (aud/nonce/enable)  | provider_rejected   |
 * | anything else                                              | try_again           |
 *
 * S1 contract note: the frozen `native/googleAuth` facade collapses BOTH
 * NoCredential and Unsupported onto kind `unavailable` (pinned by its own
 * suite — do NOT widen it here). The bridge log line keeps the exact class,
 * and this module maps `unavailable` onto `no_account` copy, which names the
 * common case (no authorized Google account) with an actionable step.
 *
 * REMAINING OWNER ACTION (single item — no console access from source):
 * install the canonical release-signed APK (package `com.findback.app`,
 * signer SHA-1 `61:E9:32:D5:14:A0:28:7B:7B:6E:49:F1:90:70:2C:F4:F7:CF:D1:8A`),
 * tap Google, and capture `adb logcat | grep GoogleAuth`. The
 * `exceptionClass=` token names the ONE console fix: provider-configuration
 * → Google Cloud console Android OAuth client for `com.findback.app` must
 * list the release SHA-1 (plus consent test-user covering the account and
 * Supabase Auth → Google enabled with the same Web client id); anything else
 * → retry on a networked device with a Google account. Source-side proof
 * (baked ID shape, env→BuildConfig→bridge wiring, package alignment,
 * one-time PKCE exchange, resolver routing) is covered by
 * `scripts/check-google-config.mjs` and the colocated suites.
 */

/** Stable failure classes. `cancelled_silent` renders nothing (user dismissed). */
export type GoogleFailureClass =
  | "setup_unavailable"
  | "no_account"
  | "device_unsupported"
  | "network"
  | "cancelled_silent"
  | "provider_rejected"
  | "rate_limited"
  | "try_again";

export function isGoogleFailureClass(value: unknown): value is GoogleFailureClass {
  return (
    value === "setup_unavailable" ||
    value === "no_account" ||
    value === "device_unsupported" ||
    value === "network" ||
    value === "cancelled_silent" ||
    value === "provider_rejected" ||
    value === "rate_limited" ||
    value === "try_again"
  );
}

/**
 * Consumer copy, one stable string per class. Tested to contain no raw
 * provider internals and no device-blaming language.
 */
export const GOOGLE_FAILURE_COPY: Record<Exclude<GoogleFailureClass, "cancelled_silent">, string> = {
  setup_unavailable: "Google sign-in isn't set up yet. Please try another sign-in method.",
  no_account: "Google sign-in isn't available — no Google account found. Add a Google account and try again.",
  device_unsupported: "Google sign-in isn't supported here. Please try another sign-in method.",
  network: "Couldn't reach Google. Check your connection and try again.",
  provider_rejected: "Google sign-in was rejected. Please try again or use another method.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  try_again: "Google sign-in failed. Please try again.",
};

/**
 * Native (Credential Manager) exception classes → failure class. Mirrors
 * `GoogleAuthPlugin.kindFor` for logcat interpretation; the S1 kind that
 * reaches JS is mapped by `classifyNativeKind` below.
 */
export const NATIVE_EXCEPTION_CLASS_TABLE: Record<string, GoogleFailureClass> = {
  GetCredentialProviderConfigurationException: "setup_unavailable",
  NoCredentialException: "no_account",
  GetCredentialUnsupportedException: "device_unsupported",
  GetCredentialCancellationException: "cancelled_silent",
  GetCredentialInterruptedException: "cancelled_silent",
  GetCredentialCustomException: "try_again",
  IOException: "network",
};

/**
 * Maps an S1 bridge kind (plus known finer aliases a future bridge may emit)
 * onto a failure class. Unknown input → `try_again` (never throws).
 */
export function classifyNativeKind(kind: unknown): GoogleFailureClass {
  if (isGoogleFailureClass(kind)) return kind;
  if (typeof kind !== "string") return "try_again";
  switch (kind) {
    case "cancelled":
    case "user_cancelled":
    case "dismissed":
      return "cancelled_silent";
    case "misconfigured":
      return "setup_unavailable";
    case "unavailable":
    case "no_credential":
    case "no_account":
      return "no_account";
    case "unsupported":
      return "device_unsupported";
    case "network":
    case "network_error":
    case "timeout":
      return "network";
    case "provider_rejected":
      return "provider_rejected";
    case "rate_limited":
      return "rate_limited";
    default:
      return "try_again";
  }
}

interface ExchangeErrorShape {
  code?: unknown;
  message?: unknown;
  status?: unknown;
}

/**
 * Maps a Supabase/transport exchange rejection onto a failure class.
 * Inspects code + message text only (stable substrings, never echoed back);
 * transport-level failures (TypeError fetch) → `network`. Unknown → `try_again`.
 */
export function classifyExchangeError(error: unknown): GoogleFailureClass {
  const shape = (error ?? {}) as ExchangeErrorShape;
  const code = typeof shape.code === "string" ? shape.code : "";
  const message = typeof shape.message === "string" ? shape.message : "";
  const text = `${code} ${message}`.toLowerCase();
  if (/over_request_rate_limit|rate.?limit|too many requests|\b429\b/.test(text)) {
    return "rate_limited";
  }
  if (
    /provider.*disabled|disabled.*provider|provider_disabled|unsupported provider|provider not enabled|validation_failed/.test(
      text,
    )
  ) {
    return "setup_unavailable";
  }
  if (
    error instanceof TypeError ||
    /failed to fetch|network ?error|networkerror|network request failed|econn|etimedout|enotfound|socket|timeout|timed out|offline|abort|load failed|not connected/.test(
      text,
    )
  ) {
    return "network";
  }
  if (
    /invalid|unauthor|forbidden|audience|\baud\b|nonce|mismatch|claim|expired|revoked|grant|verifier|pkce|exchange|token|reject|bad request|400|401|403/.test(
      text,
    )
  ) {
    return "provider_rejected";
  }
  return "try_again";
}
