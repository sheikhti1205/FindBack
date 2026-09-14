/** Injected at build time by Vite (see vite.config.ts `define`). */
declare const __API_URL__: string;

import { storage } from "./storage";

export const API_URL: string = __API_URL__;

export function apiBase(): string {
  return API_URL;
}

/**
 * Auth session storage. Access + refresh tokens (and the pending-signup email)
 * are the only auth state persisted; no password, OTP or provider key is ever
 * stored. Capacitor Preferences swap stays isolated behind these helpers.
 */
const ACCESS_KEY = "findback.auth.token";
const REFRESH_KEY = "findback.auth.refresh";
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

export function getToken(): string | null {
  return read(ACCESS_KEY);
}

export function setToken(token: string | null): void {
  write(ACCESS_KEY, token);
}

/** Supabase refresh token (rotating); absent for the local provider. */
export function getRefreshToken(): string | null {
  return read(REFRESH_KEY);
}

export function setRefreshToken(token: string | null): void {
  write(REFRESH_KEY, token);
}

/** Email awaiting pending-signup verification (Supabase Confirm-email ON). */
export function getPendingEmail(): string | null {
  return read(PENDING_EMAIL_KEY);
}

export function setPendingEmail(email: string | null): void {
  write(PENDING_EMAIL_KEY, email);
}

/** Persist a whole session, keeping any existing refresh token if omitted. */
export function setSession(session: { token: string; refreshToken?: string | null }): void {
  setToken(session.token);
  if (session.refreshToken !== undefined) setRefreshToken(session.refreshToken ?? null);
}

export function clearSession(): void {
  setToken(null);
  setRefreshToken(null);
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

/**
 * Endpoints that must never trigger an automatic refresh: the auth handshake
 * endpoints (including the public pending-email verification pair) and logout.
 */
const AUTH_ENDPOINTS = [
  "/auth/login",
  "/auth/register",
  "/auth/refresh",
  "/auth/logout",
  "/auth/email-verification",
];

function isAuthEndpoint(path: string): boolean {
  return AUTH_ENDPOINTS.some((prefix) => path.startsWith(prefix));
}

let refreshPromise: Promise<boolean> | null = null;

/**
 * Exchange the stored refresh token for a new session. The rotated refresh
 * token replaces the old one (Supabase invalidates the previous token).
 * Concurrent callers share one in-flight refresh.
 */
export function refreshAccessToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return Promise.resolve(false);
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch(`${apiBase()}/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return false;
        const data = (await res.json()) as { token?: string; refreshToken?: string };
        if (!data.token) return false;
        setToken(data.token);
        setRefreshToken(data.refreshToken ?? null);
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
  const token = getToken();
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
  if (res.status === 401 && allowRefresh && !isAuthEndpoint(path) && getRefreshToken()) {
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
