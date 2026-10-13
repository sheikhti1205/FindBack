/**
 * Intended-destination handoff across an OAuth navigation (X3).
 *
 * Before starting the browser Google redirect the app remembers where the user
 * was headed; after the callback it consumes that destination exactly once.
 * Only an internal, single-slash, credential-free route is ever accepted, so an
 * attacker-controlled `returnTo` can never become an open redirect.
 */

const KEY = "findback.authReturnTo";
const TTL_MS = 10 * 60 * 1000;

/** A safe in-app route: starts with a single `/`, no scheme, no backslash. */
export function isSafeInternalRoute(route: unknown): route is string {
  if (typeof route !== "string") return false;
  const value = route.trim();
  if (value.length === 0 || value.length > 512) return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//") || value.startsWith("/\\")) return false;
  if (value.includes("\\") || value.includes("://")) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x20 || code === 0x7f) return false;
  }
  return true;
}

export function rememberAuthReturnTo(route: string): void {
  if (!isSafeInternalRoute(route)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ route, expiresAt: Date.now() + TTL_MS }));
  } catch {
    /* navigation still works without storage */
  }
}

/** One-shot read: the entry is removed whether or not it was still valid. */
export function consumeAuthReturnTo(): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    const value = JSON.parse(raw ?? "null") as { route?: unknown; expiresAt?: unknown } | null;
    if (!value || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()) return null;
    return isSafeInternalRoute(value.route) ? value.route : null;
  } catch {
    return null;
  }
}

export function clearAuthReturnTo(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* unavailable storage */
  }
}
