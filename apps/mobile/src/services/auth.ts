import {
  apiFetch,
  ApiError,
  getRefreshToken,
  getToken,
  refreshAccessToken,
  setRefreshToken,
  setToken,
} from "./api";
import type { PublicUser } from "@findback/shared";

/** A provider session as returned by the FindBack API. */
export interface AuthSessionPayload {
  token: string;
  refreshToken?: string;
  expiresIn?: number;
  expiresAt?: number;
  user: PublicUser;
}

/** Supabase signup with Confirm-email ON: account created, no session yet. */
export interface RegisterPending {
  user: PublicUser;
  emailVerificationRequired: true;
  email: string;
}

export type RegisterResult = RegisterPending | (AuthSessionPayload & { emailVerificationRequired: false });

export async function register(input: {
  username: string;
  email: string;
  phone: string;
  password: string;
}): Promise<RegisterResult> {
  return apiFetch<RegisterResult>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function login(input: {
  identifier: string;
  password: string;
}): Promise<AuthSessionPayload> {
  return apiFetch<AuthSessionPayload>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMe(): Promise<PublicUser> {
  const res = await apiFetch<{ user: PublicUser }>("/auth/me");
  return res.user;
}

/**
 * Persist a session payload: access token, rotated refresh token, and the
 * pending-email flag cleared. Returns the authenticated user.
 */
export function persistSession(session: AuthSessionPayload): PublicUser {
  setToken(session.token);
  setRefreshToken(session.refreshToken ?? null);
  return session.user;
}

/**
 * Boot-time restoration. When only a refresh token is present (the access token
 * was cleared), obtain one first; `apiFetch` handles an expired access token by
 * refreshing transparently. Refresh failure surfaces as an error so the caller
 * can clear the session.
 */
export async function restoreSession(): Promise<PublicUser> {
  if (!getToken() && getRefreshToken()) {
    const ok = await refreshAccessToken();
    if (!ok) throw new ApiError("Session expired", 401);
  }
  return fetchMe();
}

export async function logout(): Promise<void> {
  await apiFetch("/auth/logout", { method: "POST" });
}

export async function checkUsername(
  username: string,
): Promise<{ available: boolean; normalized: string }> {
  return apiFetch<{ available: boolean; normalized: string }>(
    `/users/check-username?username=${encodeURIComponent(username)}`,
  );
}

export async function sendVerificationCode(
  channel: "EMAIL" | "PHONE",
): Promise<{ devCode?: string; expiresInSeconds?: number; resendAfterSeconds?: number }> {
  return apiFetch(`/verification/${channel}/send`, { method: "POST" });
}

export async function verifyCode(
  channel: "EMAIL" | "PHONE",
  code: string,
): Promise<{ emailVerified: boolean; phoneVerified: boolean }> {
  return apiFetch(`/verification/${channel}/verify`, {
    method: "POST",
    body: JSON.stringify({ channel, code }),
  });
}

/** Public pending-signup resend (no session needed). */
export async function sendPendingEmailCode(email: string): Promise<{ ok: true }> {
  return apiFetch("/auth/email-verification/send", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/** Public pending-signup verify: establishes the first Supabase session. */
export async function verifyPendingEmailCode(
  email: string,
  code: string,
): Promise<AuthSessionPayload & { emailVerified: boolean; phoneVerified: boolean }> {
  return apiFetch("/auth/email-verification/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
}

export async function askAiHelp(question: string): Promise<{
  text: string;
  source: "llm" | "fallback";
}> {
  return apiFetch("/ai/help", {
    method: "POST",
    body: JSON.stringify({ question }),
  });
}

export { getToken, getRefreshToken, setToken, setRefreshToken, ApiError };
