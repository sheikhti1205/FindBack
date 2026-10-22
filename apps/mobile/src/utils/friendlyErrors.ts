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
  | "UNAVAILABLE"
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
  // A confirmed write stays confirmed even if connectivity drops before
  // read-back. Never echo an arbitrary message just because it has this code.
  if (err instanceof ApiError && err.code === "READ_BACK_FAILED") {
    return { code: "SERVER", message: "Your report was saved, but the app could not read it back. Refresh to see it." };
  }
  // A contract this build points at may not exist yet on the project it
  // points at (a migration that has not been applied). The surface is ABSENT,
  // not broken, and "not available in this build" is a different fact from
  // "the server is having trouble".
  if (err instanceof ApiError && err.code === "RPC_UNAVAILABLE") {
    return { code: "UNAVAILABLE", message: "This feature is not available in this build." };
  }
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
  // A refusal that names itself keeps its own words: "You have already rated
  // this recovery" and "you have reached today's limit of 5" are the exact
  // answers the reader needs — a generic "something conflicts" sentence hides
  // the one fact the server volunteered.
  //
  // The same SQLSTATE can also carry a raw catalogue error (a genuine unique
  // violation says "duplicate key value violates unique constraint ..."), and
  // that IS developer-facing text. Only a deliberate sentence is kept; a
  // catalogue error still gets the generic sentence.
  if (err instanceof ApiError && (err.code === "23505" || err.code === "P0001")) {
    const own = clean(raw);
    const isCatalogueError = /duplicate key|unique constraint|violates|sqlstate|relation |column |syntax/i.test(own);
    if (own && !isCatalogueError)
      return { code: err.code === "23505" ? "CONFLICT" : "RATE_LIMIT", message: own };
  }
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
