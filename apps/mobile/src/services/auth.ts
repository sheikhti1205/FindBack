import {
  apiFetch,
  ApiError,
  getToken,
  setToken,
} from "../services/api";
import type { PublicUser } from "@findback/shared";

interface AuthResult {
  token: string;
  user: PublicUser;
}

export async function register(input: {
  username: string;
  email: string;
  phone: string;
  password: string;
}): Promise<AuthResult> {
  return apiFetch<AuthResult>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function login(input: {
  identifier: string;
  password: string;
}): Promise<AuthResult> {
  return apiFetch<AuthResult>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMe(): Promise<PublicUser> {
  const res = await apiFetch<{ user: PublicUser }>("/auth/me");
  return res.user;
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
): Promise<{ devCode?: string; expiresInSeconds: number; resendAfterSeconds: number }> {
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

export async function askAiHelp(question: string): Promise<{
  text: string;
  source: "llm" | "fallback";
}> {
  return apiFetch("/ai/help", {
    method: "POST",
    body: JSON.stringify({ question }),
  });
}

export { getToken, setToken, ApiError };
