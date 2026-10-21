/**
 * Client session state shared by the Supabase-native services (Block 10K).
 *
 * The app talks only to hosted Supabase (Auth / Data API / Realtime / Storage /
 * Edge Functions). This module keeps the small amount of cross-cutting state:
 * an in-memory access-token cache and the pending-signup email.
 */
import { storage } from "./storage";
import { AuthAccountChangedError } from "./accountScopedAuthStorage";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ApiError";
  }
}

/**
 * In-memory cache of the current Supabase access token. The Supabase SDK owns
 * persistence; this cache only lets synchronous callers read the token without
 * awaiting.
 */
let accessToken: string | null = null;
let tokenRevision = 0;

/** Detect cache changes while an SDK snapshot is pending, including A -> B -> null. */
export function getTokenRevision(): number { return tokenRevision; }

export function getToken(): string | null {
  return accessToken;
}

export function setToken(token: string | null): void {
  accessToken = token;
  tokenRevision += 1;
}

/** An awaited SDK response cannot overwrite an intervening auth event. */
export function cacheSessionToken(token: string, startedAtRevision: number): void {
  if (startedAtRevision === tokenRevision) setToken(token);
  else if (accessToken !== token) throw new AuthAccountChangedError();
}

/** Email awaiting pending-signup verification (Supabase Confirm-email ON). */
const PENDING_EMAIL_KEY = "findback.auth.pendingEmail";

function read(key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export function getPendingEmail(): string | null {
  return read(PENDING_EMAIL_KEY);
}

export function setPendingEmail(email: string | null): void {
  write(PENDING_EMAIL_KEY, email);
}

export function clearAllAuth(): void {
  setToken(null);
  setPendingEmail(null);
}

/**
 * Account-switch isolation (W5-IDENTITY).
 *
 * Starts an A -> sign out -> B switch without a process restart: clears this
 * session's token cache and pending verification email, then notifies
 * signed-out handlers so providers drop A-owned user state. Callers must ALSO
 * run the user-scoped wipe (`clearUserScopedLocalState`: drafts, staged
 * photos, feed caches, Nearby session, local-AI residency) plus realtime and
 * push teardown — `auth.tsx` owns those on every sign-out path. This helper
 * covers the session-owned slice so a stale token or pending email can never
 * leak into B's calls. Never touches stored credentials of any account.
 */
export function beginAccountSwitch(): void {
  setToken(null);
  setPendingEmail(null);
  notifySignedOut();
}

// ---- signed-out notification (mid-session refresh failure) ----

const signedOutHandlers = new Set<() => void>();

export function onSignedOut(handler: () => void): () => void {
  signedOutHandlers.add(handler);
  return () => signedOutHandlers.delete(handler);
}

export function notifySignedOut(): void {
  for (const handler of signedOutHandlers) handler();
}
