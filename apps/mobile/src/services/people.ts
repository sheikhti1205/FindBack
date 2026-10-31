import type { SearchedProfile } from "@findback/shared";
import { getSupabase } from "./supabaseClient";
import { isValidAvatarObjectKey } from "./avatar";

export interface PeopleSearchCursor { query: string; rank: number; username: string; id: string }
export interface PeopleSearchPage { items: SearchedProfile[]; nextCursor: PeopleSearchCursor | null }
export function normalizePeopleQuery(query: string): string { return query.trim().replace(/^@/, "").trim().toLowerCase(); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function cursorFor(value: unknown, query: string): PeopleSearchCursor | null {
  if (value === null) return null;
  if (!record(value) || value.query !== query || ![0, 1, 2].includes(value.rank as number)
    || typeof value.username !== "string" || !value.username || value.username.length > 100
    || typeof value.id !== "string" || !value.id || value.id.length > 100) throw new Error("Invalid people search cursor");
  return { query, rank: value.rank as number, username: value.username, id: value.id };
}
/** Explicit safe-field projection; neither client cache nor relationship writes
 * are part of discovery. Callers own account/query lifetimes and pagination. */
export async function searchPeople(query: string, options: { cursor?: PeopleSearchCursor | null; limit?: number; signal?: AbortSignal } = {}): Promise<PeopleSearchPage> {
  const normalized = normalizePeopleQuery(query);
  options.signal?.throwIfAborted();
  if (normalized.length > 80) throw new Error("Search query too long");
  if (!normalized) return { items: [], nextCursor: null };
  const cursor = cursorFor(options.cursor ?? null, normalized);
  const limit = Math.max(1, Math.min(30, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 20));
  const request = getSupabase().rpc("findback_search_people", { p_query: normalized, p_cursor: cursor, p_limit: limit });
  const { data, error } = await (options.signal ? request.abortSignal(options.signal) : request);
  options.signal?.throwIfAborted();
  if (error) throw new Error("People search unavailable");
  if (!record(data) || !Array.isArray(data.items) || data.items.length > limit) throw new Error("Invalid people search page");
  const items = data.items.map((row: unknown): SearchedProfile => {
    if (!record(row) || typeof row.id !== "string" || !row.id || typeof row.username !== "string" || !row.username
      || !(row.display_name === null || typeof row.display_name === "string")
      || !(row.avatar_url === null || typeof row.avatar_url === "string")) throw new Error("Invalid public identity");
    return { id: row.id, username: row.username, displayName: row.display_name,
      avatarUrl: typeof row.avatar_url === "string" && isValidAvatarObjectKey(row.avatar_url, row.id) ? row.avatar_url : null };
  });
  return { items, nextCursor: cursorFor(data.nextCursor, normalized) };
}
