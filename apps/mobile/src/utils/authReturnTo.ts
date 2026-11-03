/**
 * Intended-destination handoff across an OAuth navigation (X3).
 *
 * Before starting the browser Google redirect the app remembers where the user
 * was headed; after the callback it consumes that destination exactly once.
 * Only an internal, single-slash, credential-free route is ever accepted, so an
 * attacker-controlled `returnTo` can never become an open redirect.
 */

import { getPendingReportRoute } from "./pendingReportLink";

const KEY = "findback.authReturnTo";
const TTL_MS = 10 * 60 * 1000;

/** A safe in-app route: starts with a single `/`, no scheme, no backslash. */
export function isSafeInternalRoute(route: unknown): route is string {
  if (typeof route !== "string") return false;
  const value = route;
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
  if (!safeAuthReturnTo(route)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ route, expiresAt: Date.now() + TTL_MS }));
  } catch {
    /* navigation still works without storage */
  }
}

/** One-shot read: the entry is removed whether or not it was still valid. */
export function consumeAuthReturnTo(): string | null {
  const route = peekAuthReturnTo();
  clearAuthReturnTo();
  return route;
}

/** Only known app destinations, never auth/recovery loops or callback material. */
export function safeAuthReturnTo(route: unknown): string | null {
  if (!isSafeInternalRoute(route)) return null;
  try {
    // Decode the path separately: query values may contain encoded spaces, but
    // encoded path separators/delimiters and another decoding layer are unsafe.
    const rawPath = route.split(/[?#]/, 1)[0]!;
    if (/%(?:2f|5c|3f|23|25)/i.test(rawPath)) return null;
    const pathname = decodeURIComponent(rawPath);
    if (!isSafeInternalRoute(pathname)) return null;
    const decoded = decodeURIComponent(route);
    if ([...decoded].some(char => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f || char === "\\")
      || /[?#&](?:access_token|refresh_token|id_token|code|token|token_hash|password)=/i.test(decoded)) return null;
    if (pathname.includes("//") || pathname.split("/").some(part => part === "." || part === "..")) return null;
    if (!/^\/(?:$|(?:posts|u|chats|connections|search|saved|my|profile|report|settings)(?:\/|$)|(?:notifications|about|help|ai-connection|ai-models|offline-ai)$)/.test(pathname)) return null;
    return route;
  } catch { return null; }
}

/** Non-consuming: profile completion and OAuth may both need the same intent. */
export function peekAuthReturnTo(): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const value = JSON.parse(raw ?? "null") as { route?: unknown; expiresAt?: unknown } | null;
    if (!value || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()
      || value.expiresAt > Date.now() + TTL_MS) { clearAuthReturnTo(); return null; }
    const route = safeAuthReturnTo(value.route);
    if (!route) clearAuthReturnTo();
    return route;
  } catch {
    return null;
  }
}

/** Shared reports keep their existing pending-link authority and resume handler. */
export function getAuthReturnRoute(): string {
  return getPendingReportRoute() ?? peekAuthReturnTo() ?? "/";
}

export function clearAuthReturnTo(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* unavailable storage */
  }
}
