/**
 * W0-A (S1) — Google ID-token native bridge facade.
 *
 * Frozen contract from `Communication/INTERFACES.md` (S1). The native side is
 * `GoogleAuthPlugin.java` (Android Credential Manager + Google ID option);
 * this module is the only JS surface the auth service (W0-B) touches.
 *
 * Fail-closed rules pinned by `googleAuth.test.ts`:
 *   - off Android every call fails with `GoogleAuthError` (kind
 *     `unavailable`) before the Capacitor bridge is registered,
 *   - a native availability probe reporting unconfigured/unavailable rejects
 *     with `misconfigured`/`unavailable` and the credential request is never
 *     sent (no fake success is ever produced),
 *   - errors surface as `GoogleAuthError` with our own stable human message —
 *     never raw platform text (which could echo credential material),
 *   - the `idToken` is NEVER logged/printed, and error messages never carry
 *     it.
 *
 * Mode mapping (never combined):
 *   - `signin` → `filterByAuthorizedAccounts=true`, no phone request,
 *   - `signup` → `filterByAuthorizedAccounts=false` +
 *     `requestVerifiedPhoneNumber=true` (Android only, enforced by the
 *     platform guard above and re-checked natively).
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

export interface GoogleIdTokenResult {
  idToken: string;
  /** Raw single-use nonce (native-generated, SecureRandom). The caller passes
   *  it as `nonce` to Supabase `signInWithIdToken`; the hashed form went to
   *  Google as the ID-option nonce. NEVER logged/printed. */
  nonce: string;
  email?: string | null;
  /** Display-name SEED only. Never treated as identity. */
  name?: string | null;
  /**
   * Avatar SEED only. Google-hosted URL shown as preview; persistence
   * allowlists Google hosts, else null. Never an arbitrary remote URL.
   */
  avatarUrl?: string | null;
  /**
   * Verified phone ONLY when explicitly requested on sign-up flow.
   * Absent unless legitimately returned. NEVER assumed present.
   */
  phone?: string | null;
}

export type GoogleAuthFailureKind =
  | "cancelled"
  | "unavailable"
  | "misconfigured"
  | "network"
  | "unknown";

export class GoogleAuthError extends Error {
  readonly kind: GoogleAuthFailureKind;

  constructor(kind: GoogleAuthFailureKind, message: string) {
    super(message);
    this.name = "GoogleAuthError";
    this.kind = kind;
  }
}

/** Stable user-facing messages. Never built from platform text. */
const MESSAGES: Record<GoogleAuthFailureKind, string> = {
  cancelled: "Google sign-in was cancelled.",
  unavailable: "Google sign-in is not available on this device.",
  misconfigured: "Google sign-in is not configured yet. Please try another sign-in method.",
  network: "Could not reach Google sign-in. Check your connection and try again.",
  unknown: "Google sign-in failed. Please try again.",
};

interface NativeGoogleAuthBridge {
  isAvailable(): Promise<unknown>;
  signIn(options: Record<string, unknown>): Promise<unknown>;
}

let bridge: NativeGoogleAuthBridge | null = null;

/**
 * Platform guard runs *before* `registerPlugin` so a browser page (or
 * non-Android native shell) can never reach the Android bridge.
 */
function isAndroidApp(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

function native(): NativeGoogleAuthBridge {
  if (!isAndroidApp()) {
    throw new GoogleAuthError("unavailable", MESSAGES.unavailable);
  }
  bridge ??= registerPlugin<NativeGoogleAuthBridge>("GoogleAuth");
  return bridge;
}

export function isGoogleAuthAvailable(): boolean {
  return isAndroidApp();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function isFailureKind(value: unknown): value is GoogleAuthFailureKind {
  return typeof value === "string" && value in MESSAGES;
}

/**
 * Maps any native rejection onto the shared taxonomy. The native side already
 * sends kind strings; aliases from older/alternate providers collapse onto
 * the same kinds. Anything unrecognized becomes `unknown`. Raw platform text
 * is discarded — the message always comes from `MESSAGES`.
 */
function extractKind(reason: unknown): GoogleAuthFailureKind {
  const record = asRecord(reason);
  // Capacitor has three relevant reject overloads, and they pack differently:
  //   reject(msg, code)                → { message, code }
  //   reject(msg, JSObject data)       → { message, data: { … } }
  //                                      (no `code` KEY: put(name, null) removes it)
  //   reject(msg, code, JSObject data) → { message, code, data: { … } }
  // The native plugin must use the THIRD form (kind in `code`, detail in `data`).
  // Read the nested slot as well, so a future edit that regresses to the two-arg
  // JSObject form cannot silently collapse every signIn-stage rejection onto
  // "unknown" again — that regression is exactly what shipped: it turned a
  // dismissed prompt into an error banner and reported "no Google account" as an
  // unactionable "try again". (The availability probe's `misconfigured` result
  // never reaches this function; it is classified via `availabilityKind`.)
  const topLevel = record["code"];
  const raw = typeof topLevel === "string" ? topLevel : asRecord(record["data"])["code"];
  if (typeof raw !== "string") return "unknown";
  if (isFailureKind(raw)) return raw;
  switch (raw) {
    case "user_cancelled":
    case "dismissed":
      return "cancelled";
    case "no_credential":
      return "unavailable";
    case "network_error":
    case "timeout":
      return "network";
    default:
      return "unknown";
  }
}

function availabilityKind(raw: unknown): GoogleAuthFailureKind {
  const record = asRecord(raw);
  if (record["available"] === true) return "unknown";
  const reason = record["reason"];
  if (reason === "misconfigured") return "misconfigured";
  return "unavailable";
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Avatar preview allowlist: only Google-hosted https URLs pass through.
 * Anything else becomes null so an arbitrary remote URL can never enter the
 * sign-up seed (persistence re-checks the same rule, W0-B).
 */
function sanitizeAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "googleusercontent.com" || host.endsWith(".googleusercontent.com")) {
    return value;
  }
  return null;
}

async function checkConfigured(android: NativeGoogleAuthBridge): Promise<void> {
  let raw: unknown;
  try {
    raw = await android.isAvailable();
  } catch {
    // An unreadable probe is not a configured provider: fail closed.
    throw new GoogleAuthError("unavailable", MESSAGES.unavailable);
  }
  if (asRecord(raw)["available"] === true) return;
  const kind = availabilityKind(raw);
  throw new GoogleAuthError(kind, MESSAGES[kind]);
}

function normalizeResult(raw: unknown): GoogleIdTokenResult {
  const record = asRecord(raw);
  const idToken = record["idToken"];
  if (typeof idToken !== "string" || idToken.length === 0) {
    // Never resolve an empty "success": callers must not proceed without a token.
    throw new GoogleAuthError("unknown", MESSAGES.unknown);
  }
  const nonce = record["nonce"];
  if (typeof nonce !== "string" || nonce.length === 0) {
    // The raw nonce is required: without it the Supabase server-side
    // nonce check cannot pass, so resolving would only produce a
    // doomed exchange. Fail closed with the same unknown kind.
    throw new GoogleAuthError("unknown", MESSAGES.unknown);
  }
  return {
    idToken,
    nonce,
    email: asOptionalString(record["email"]),
    name: asOptionalString(record["name"]),
    avatarUrl: sanitizeAvatarUrl(record["avatarUrl"]),
    phone: asOptionalString(record["phone"]),
  };
}

export async function startGoogleSignIn(opts: {
  mode: "signin" | "signup";
}): Promise<GoogleIdTokenResult> {
  const android = native();
  await checkConfigured(android);

  const payload: Record<string, unknown> =
    opts.mode === "signin"
      ? { filterByAuthorizedAccounts: true }
      : { filterByAuthorizedAccounts: false, requestVerifiedPhoneNumber: true };

  let raw: unknown;
  try {
    raw = await android.signIn(payload);
  } catch (reason) {
    if (reason instanceof GoogleAuthError) throw reason;
    const kind = extractKind(reason);
    throw new GoogleAuthError(kind, MESSAGES[kind]);
  }
  return normalizeResult(raw);
}
