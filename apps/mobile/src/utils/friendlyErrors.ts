import { ApiError } from "../services/session";

/**
 * Central error taxonomy: raw failures become one clear human message plus a
 * stable code. Backend/Supabase jargon never reaches normal UI.
 */
export type ErrorCode =
  | "OFFLINE"
  | "TIMEOUT"
  | "VALIDATION"
  | "AUTH"
  | "PERMISSION"
  | "CONFLICT"
  | "NOT_FOUND"
  | "RATE_LIMIT"
  | "SERVER"
  | "UNKNOWN";

export interface FriendlyError {
  code: ErrorCode;
  message: string;
}

const JARGON = [/supabase/gi, /postgrest/gi, /postgres/gi, /\brpc\b/gi, /jwt/gi];

function clean(message: string): string {
  let out = message;
  for (const re of JARGON) out = out.replace(re, "server");
  return out.replace(/\s+/g, " ").trim();
}

export function friendlyError(err: unknown): FriendlyError {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { code: "OFFLINE", message: "You are offline. Check your connection and try again." };
  }
  const status = err instanceof ApiError ? err.status : null;
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const lower = raw.toLowerCase();

  if (status === 401) return { code: "AUTH", message: "Your session expired. Please sign in again." };
  if (status === 403)
    return { code: "PERMISSION", message: "You do not have permission to do that." };
  if (status === 404) return { code: "NOT_FOUND", message: "That item could not be found." };
  if (status === 409)
    return { code: "CONFLICT", message: "That conflicts with something already saved. Refresh and try again." };
  if (status === 429)
    return { code: "RATE_LIMIT", message: "Too many attempts. Wait a moment and try again." };
  if (status != null && status >= 500)
    return { code: "SERVER", message: "The server is having trouble. Try again in a bit." };
  if (status === 400 || /invalid|required|too long|malformed/.test(lower))
    return { code: "VALIDATION", message: clean(raw) || "Check the highlighted fields and try again." };
  if (/timeout|timed out|abort/i.test(lower))
    return { code: "TIMEOUT", message: "The request timed out. Try again." };
  if (/network|fetch|failed to fetch|load failed/i.test(lower))
    return { code: "OFFLINE", message: "Network problem. Check your connection and try again." };
  return { code: "UNKNOWN", message: clean(raw) || "Something went wrong. Try again." };
}
