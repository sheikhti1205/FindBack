/**
 * External auth entry bridge for a HashRouter app (X3/X4).
 *
 * OAuth and password-recovery callbacks arrive as ordinary PATHS with a
 * `?code=...`/`?error=...` query, while the app routes from the hash. This
 * module recognises the allowlisted auth paths, validates the origin, and
 * captures the credential-bearing query so it can be processed in-app and
 * stripped from the address bar immediately — the code is never left in the
 * URL/history and never logged.
 */
import {
  AUTH_CALLBACK_PATH,
  RECOVERY_PATH,
  isAllowedAuthOrigin,
  isLocalDevOrigin,
} from "./authRedirect";

export type ExternalAuthKind = "auth-callback" | "recovery";

export const EXTERNAL_AUTH_PATHS = [AUTH_CALLBACK_PATH, RECOVERY_PATH] as const;

export interface ExternalAuthEntry {
  kind: ExternalAuthKind;
  /** PKCE code from the provider/email link, or "" when absent. */
  code: string;
  /** Provider error code (e.g. `access_denied`), or "" when absent. */
  error: string;
  /** Path + query as received (origin-relative), for diagnostics only. */
  path: string;
}

export interface ExternalAuthParseInput {
  pathname: string;
  search?: string;
  origin?: string;
  /** Explicit origin allowlist (tests). When omitted, config-derived. */
  allowedOrigins?: readonly string[];
  env?: Record<string, string | undefined>;
}

function sanitizeCredential(value: string): string {
  if (value.length > 4096) return "";
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) <= 0x1f) return "";
  }
  return value;
}

/** Pure, total: returns null for any non-auth path or disallowed origin. */
export function parseExternalAuthEntry(input: ExternalAuthParseInput): ExternalAuthEntry | null {
  const { pathname, search = "", origin, allowedOrigins, env } = input;
  const kind: ExternalAuthKind | null =
    pathname === AUTH_CALLBACK_PATH
      ? "auth-callback"
      : pathname === RECOVERY_PATH
        ? "recovery"
        : null;
  if (!kind) return null;
  if (origin) {
    const ok = allowedOrigins
      ? allowedOrigins.some((a) => a.trim().replace(/\/+$/, "") === origin.trim().replace(/\/+$/, "")) ||
        isLocalDevOrigin(origin)
      : isAllowedAuthOrigin(origin, env);
    if (!ok) return null;
  }
  const params = new URLSearchParams(search);
  const code = sanitizeCredential((params.get("code") ?? "").trim());
  const error = sanitizeCredential((params.get("error") ?? params.get("error_code") ?? "").trim());
  return { kind, code, error, path: `${pathname}${search}` };
}

let pending: ExternalAuthEntry | null = null;

/** Test hook. */
export function __setPendingExternalAuthEntry(entry: ExternalAuthEntry | null): void {
  pending = entry;
}

/** One-shot consume of the captured entry. */
export function takePendingExternalAuthEntry(): ExternalAuthEntry | null {
  const entry = pending;
  pending = null;
  return entry;
}

/**
 * Capture + strip, safe to call before React mounts. When the browser landed
 * on an allowlisted auth path, the credential-bearing path/query is replaced
 * with `/` via `history.replaceState` so it disappears from the address bar and
 * the back/forward history entry, then the entry is stashed for processing.
 */
export function captureExternalAuthEntryFromWindow(win: Window = window): ExternalAuthEntry | null {
  let entry: ExternalAuthEntry | null = null;
  try {
    entry = parseExternalAuthEntry({
      pathname: win.location.pathname,
      search: win.location.search,
      origin: win.location.origin,
    });
  } catch {
    return null;
  }
  if (!entry) return null;
  pending = entry;
  try {
    win.history.replaceState(null, "", "/");
  } catch {
    /* best effort: processing still proceeds with the stashed entry */
  }
  return entry;
}
