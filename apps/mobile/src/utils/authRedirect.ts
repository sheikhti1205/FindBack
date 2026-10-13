/**
 * Auth redirect / callback configuration (X3/X6).
 *
 * The browser Google flow and the password-recovery email both return the user
 * to an ordinary PATH on a known web origin, while the app routes from the
 * hash (HashRouter). This module is the single owner of which origins and
 * paths are valid auth entry points, so the callback bridge, the OAuth
 * redirect builder, and the config validator all agree.
 *
 * These are PUBLIC origins — no secrets live here and none may be added.
 */

/** Canonical production web origin. */
export const PROD_AUTH_ORIGIN = "https://findbackapp.social";
/** Azure Static Web Apps default hostname (secondary, still owner-controlled). */
export const AZURE_DEFAULT_AUTH_ORIGIN =
  "https://ambitious-wave-0f1b6c500.3.azurestaticapps.net";

/** Provider/email callback path the app handles outside the hash. */
export const AUTH_CALLBACK_PATH = "/auth/callback";
/** Password-recovery landing path outside the hash. */
export const RECOVERY_PATH = "/recovery";

type Env = Record<string, string | undefined>;

/** Loopback dev origins (any port) are always allowed auth entry points. */
export function isLocalDevOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

/**
 * Every origin a browser auth callback may legitimately land on. Derived from
 * the public share origin plus the two owned web origins; never from user
 * input.
 */
export function allowedAuthOrigins(env: Env = import.meta.env as unknown as Env): string[] {
  const origins = new Set<string>([PROD_AUTH_ORIGIN, AZURE_DEFAULT_AUTH_ORIGIN]);
  const share = (env?.VITE_PUBLIC_SHARE_ORIGIN ?? "").trim();
  if (share) {
    try {
      origins.add(new URL(share).origin);
    } catch {
      /* ignore malformed share origin */
    }
  }
  return [...origins];
}

export function isAllowedAuthOrigin(origin: string, env?: Env): boolean {
  if (typeof origin !== "string" || origin.trim() === "") return false;
  if (isLocalDevOrigin(origin)) return true;
  const candidate = normalizeOrigin(origin);
  return allowedAuthOrigins(env).some((allowed) => allowed === candidate);
}

/** Absolute OAuth callback URL for the given browser origin. */
export function authCallbackUrl(origin: string): string {
  return `${normalizeOrigin(origin)}${AUTH_CALLBACK_PATH}`;
}

/** Absolute recovery URL for the given browser origin. */
export function recoveryUrl(origin: string): string {
  return `${normalizeOrigin(origin)}${RECOVERY_PATH}`;
}
