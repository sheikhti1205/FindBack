import { storage } from "./storage";
import { hasStoredAuthSession } from "./supabaseClient";

/**
 * The one owner of the "your session expired" notice.
 *
 * A real expiry is a fact the user must be told: the app signs them out and
 * lands them on the sign-in screen, and without a sentence that reads like the
 * app forgot them. A plain sign-out is NOT an expiry and never produces one.
 *
 * The flag is persisted, so the reason survives a page reload; it is cleared
 * when a session is established again.
 *
 * This module is deliberately dependency-light (storage only) so any consumer
 * can read the sentence without pulling in the Supabase client.
 */
const EXPIRED_KEY = "findback.auth.sessionExpired";

export function sessionExpiryCandidate(): boolean {
  try { return hasStoredAuthSession(); } catch { return false; }
}

/** The plain consumer sentence. No jargon, no provider detail, no stack. */
export const SESSION_EXPIRED_MESSAGE = "Your session expired. Sign in again.";

/** Record a real expiry so the next sign-in screen can explain it. */
export function markSessionExpired(): void {
  try {
    storage.setItem(EXPIRED_KEY, "1");
  } catch {
    /* storage unavailable: the notice is skipped, never faked */
  }
}

/** Forget a recorded expiry (a session exists again). */
export function clearSessionExpired(): void {
  try {
    storage.removeItem(EXPIRED_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** True when an expiry is waiting to be shown. Reading does not clear it. */
export function sessionExpiredPending(): boolean {
  try {
    return storage.getItem(EXPIRED_KEY) === "1";
  } catch {
    return false;
  }
}
