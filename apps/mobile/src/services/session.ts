/**
 * Client session state shared by the Supabase-native services (Block 10K).
 *
 * The app talks only to hosted Supabase (Auth / Data API / Realtime / Storage /
 * Edge Functions). This module keeps the small amount of cross-cutting state:
 * an in-memory access-token cache and the pending-signup email.
 */
import { storage } from "./storage";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

/**
 * In-memory cache of the current Supabase access token. The Supabase SDK owns
 * persistence; this cache only lets synchronous callers read the token without
 * awaiting.
 */
let accessToken: string | null = null;

export function getToken(): string | null {
  return accessToken;
}

export function setToken(token: string | null): void {
  accessToken = token;
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

// ---- signed-out notification (mid-session refresh failure) ----

const signedOutHandlers = new Set<() => void>();

export function onSignedOut(handler: () => void): () => void {
  signedOutHandlers.add(handler);
  return () => signedOutHandlers.delete(handler);
}

export function notifySignedOut(): void {
  for (const handler of signedOutHandlers) handler();
}
