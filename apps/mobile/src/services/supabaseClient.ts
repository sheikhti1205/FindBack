/** Injected at build time by Vite (see vite.config.ts `define`). */
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_PUBLISHABLE_KEY__: string;

import { createClient, navigatorLock, processLock, type SupabaseClient } from "@supabase/supabase-js";
import { storage } from "./storage";
import { createAccountScopedAuthStorage } from "./accountScopedAuthStorage";

export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseConfigError";
  }
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

/** Rejects keys that must never ship in a client bundle. Never logs the key. */
export function isLikelySecretKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.startsWith("sb_secret_")) return true;
  const parts = trimmed.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]!)) as { role?: unknown };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

export function validateSupabaseConfig(url: string, key: string): { url: string; key: string } {
  const trimmedUrl = url.trim();
  const trimmedKey = key.trim();
  if (!trimmedUrl) throw new SupabaseConfigError("Supabase URL is not configured");
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    throw new SupabaseConfigError("Supabase URL must be an http(s) URL");
  }
  if (!trimmedKey) throw new SupabaseConfigError("Supabase publishable key is not configured");
  if (isLikelySecretKey(trimmedKey)) {
    throw new SupabaseConfigError(
      "Supabase secret key detected; use the publishable key for the mobile app",
    );
  }
  return { url: trimmedUrl, key: trimmedKey };
}

let client: SupabaseClient | null = null;
let authPersistence: ReturnType<typeof createAccountScopedAuthStorage> | null = null;
function sessionStorageKey(url: string): string {
  return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
}

/** Presence only; read before SDK startup can discard an expired session. */
export function hasStoredAuthSession(): boolean {
  try {
    return storage.getItem(sessionStorageKey(__SUPABASE_URL__)) !== null;
  } catch { return false; }
}

/**
 * Lazily create the Supabase client. Config is validated on first use (not at
 * module import) so tests and unused code paths never touch the injected env.
 */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  const { url, key } = validateSupabaseConfig(__SUPABASE_URL__, __SUPABASE_PUBLISHABLE_KEY__);
  const storageKey = sessionStorageKey(url);
  authPersistence = createAccountScopedAuthStorage(storage, storageKey);
  client = createClient(url, key, {
    auth: {
      storageKey,
      storage: authPersistence.storage,
      lock: globalThis.navigator?.locks ? navigatorLock : processLock,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      // X4: one explicit auth-code strategy — PKCE. Browser Google OAuth and
      // password recovery both exchange a `code` explicitly via the callback
      // bridge; `signInWithIdToken` (native) is unaffected by flow type.
      flowType: "pkce",
    },
  });
  return client;
}

/** Keep cleanup attached to its captured account across SDK/network awaits. */
export async function signOutSupabaseAccount(accountId: string): Promise<void> {
  const sdk = getSupabase();
  await authPersistence!.cleanAccount(accountId, async () => {
    // Default (global) scope is preserved: sign-out still revokes this
    // account's other sessions server-side, matching the pre-existing
    // behavior. The SDK removes persisted state even when the remote call
    // fails, and the boundary verifies that removal rather than trusting a 200.
    await sdk.auth.signOut();
  });
}

export interface RawFunctionRequest {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: ArrayBuffer;
  signal: AbortSignal;
}
interface FunctionAuthPort {
  getSession(): Promise<{ data: { session: { user: { id: string }; access_token: string } | null }; error: unknown }>;
}

/** Raw-response counterpart to functions.invoke; reuses, never owns, auth. */
export function createSupabaseFunctionFetch(
  config: { url: string; key: string }, auth: FunctionAuthPort, transport: typeof fetch = globalThis.fetch,
) {
  const validated = validateSupabaseConfig(config.url, config.key);
  const base = new URL(validated.url);
  if (base.username || base.password || base.search || base.hash) throw new SupabaseConfigError("Invalid Supabase URL");
  const functionsUrl = `${base.href.replace(/\/$/, "")}/functions/v1/`;
  return async (name: string, accountId: string, input: RawFunctionRequest): Promise<Response> => {
    const unavailable = () => new Error("Request unavailable");
    const signal = input.signal;
    const live = () => { if (signal.aborted) throw unavailable(); };
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(unavailable()); });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try { return await Promise.race([promise, cancelled]); }
      finally { signal.removeEventListener("abort", abort); }
    };
    try {
      live();
      if (!/^[a-zA-Z0-9_-]+$/.test(name) || !accountId || (input.method !== "GET" && input.method !== "POST")) throw unavailable();
      const method = input.method, headers = new Headers(input.headers), body = input.body?.slice(0);
      const { data, error } = await wait(auth.getSession());
      live();
      const session = data.session;
      if (error || session?.user.id !== accountId || !session.access_token?.trim()) throw unavailable();
      headers.set("Authorization", `Bearer ${session.access_token}`);
      headers.set("apikey", validated.key);
      const response = await wait(transport(`${functionsUrl}${name}`, {
        method, headers, body, signal, credentials: "omit", redirect: "error", cache: "no-store",
      }).then((result) => {
        if (signal.aborted || result.redirected || result.type === "opaque") {
          void result.body?.cancel().catch(() => undefined); throw unavailable();
        }
        return result;
      }));
      if (signal.aborted) { void response.body?.cancel().catch(() => undefined); throw unavailable(); }
      return response;
    } catch { throw unavailable(); }
  };
}

/** Production raw access always comes from the canonical SDK and build config. */
export function fetchSupabaseFunction(name: string, accountId: string, input: RawFunctionRequest): Promise<Response> {
  return createSupabaseFunctionFetch(
    validateSupabaseConfig(__SUPABASE_URL__, __SUPABASE_PUBLISHABLE_KEY__), getSupabase().auth,
  )(name, accountId, input);
}
