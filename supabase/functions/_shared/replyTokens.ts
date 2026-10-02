/**
 * Shared reply-token helpers for push-dispatch and reply-comment.
 * Pure and dependency-free so both functions (and their tests) stay in sync.
 */

export const MAX_REPLY_BODY = 1000;
export const MAX_REPLY_DEPTH = 5;
export const REPLY_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReplyTokenRow {
  id: string;
  user_id: string;
  post_id: string;
  parent_comment_id: string;
  expires_at: string;
  used_at: string | null;
}

/** 1-1000 characters after trimming; null when invalid. */
export function normalizeReplyBody(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const trimmed = body.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_REPLY_BODY) return null;
  return trimmed;
}

/** A token must be a 43-char base64url string (32 random bytes). */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export interface TokenDecision {
  ok: boolean;
  reason?: "used" | "expired" | "missing";
}

/** Pure eligibility check for a looked-up token row. */
export function evaluateReplyToken(row: ReplyTokenRow | null, nowIso: string): TokenDecision {
  if (!row) return { ok: false, reason: "missing" };
  if (row.used_at) return { ok: false, reason: "used" };
  if (row.expires_at <= nowIso) return { ok: false, reason: "expired" };
  return { ok: true };
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateReplyToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
