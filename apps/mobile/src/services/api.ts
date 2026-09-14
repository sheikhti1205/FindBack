/** Injected at build time by Vite (see vite.config.ts `define`). */
declare const __API_URL__: string;

import { storage } from "./storage";
import { getSupabase } from "./supabaseClient";

/** Base URL of the legacy Node API (posts, comments, realtime, reporting, AI). */
export const API_URL: string = __API_URL__;

export function apiBase(): string {
  return API_URL;
}

/**
 * In-memory cache of the current Supabase access token. The Supabase SDK owns
 * persistence; this cache only lets synchronous callers (realtime handshake)
 * read the token without awaiting.
 */
let accessToken: string | null = null;

export function getToken(): string | null {
  return accessToken;
}

export function setToken(token: string | null): void {
  accessToken = token;
}

/** Read the current Supabase session and refresh the in-memory cache. */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token ?? null;
  accessToken = token;
  return token;
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

export function clearSession(): void {
  setToken(null);
}

export function clearAllAuth(): void {
  clearSession();
  setPendingEmail(null);
}

// ---- signed-out notification (mid-session refresh failure) ----

const signedOutHandlers = new Set<() => void>();

export function onSignedOut(handler: () => void): () => void {
  signedOutHandlers.add(handler);
  return () => signedOutHandlers.delete(handler);
}

function notifySignedOut(): void {
  for (const handler of signedOutHandlers) handler();
}

// ---- 401 -> refresh -> retry (single-flight) ----

let refreshPromise: Promise<boolean> | null = null;

/** Refresh the Supabase session once, sharing one in-flight refresh. */
export function refreshAccessToken(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const { data, error } = await getSupabase().auth.refreshSession();
        if (error || !data.session?.access_token) return false;
        setToken(data.session.access_token);
        return true;
      } catch {
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string") headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${apiBase()}${path}`, { ...init, headers });
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    /* non-JSON error */
  }
  return new ApiError(message, res.status);
}

async function request<T>(path: string, init: RequestInit, allowRefresh: boolean): Promise<T> {
  const res = await rawFetch(path, init);
  if (res.status === 401 && allowRefresh && getToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request<T>(path, init, false);
    clearSession();
    notifySignedOut();
  }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

export function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, init, true);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
