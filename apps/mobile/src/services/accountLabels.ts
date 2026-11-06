/**
 * Account labels — the ONE client read that turns a user id into a name a
 * reader can recognise.
 *
 * WHY THIS FILE EXISTS. `services/blocks.ts` deliberately returns no name
 * ("One account the caller has blocked. Never a name, never a direction"), so
 * the blocked-accounts list had nothing to put on a row. The D22 copy the
 * contract names — "You've unblocked X" — needs an X, and a raw id is not a
 * name. This file reads the ONE public column the app already publishes for
 * every account (`users.username`, granted to `authenticated` in
 * `20260920000000_users_privacy_convergence.sql` and read by the existing
 * `services/auth.ts`) and nothing else.
 *
 * WHAT IT DOES NOT DO.
 *
 *   * It does not read a direction. It cannot: it has no block access at all.
 *   * It does not read anything private. Only `id` and `username` are
 *     selected; email, phone and the password hash are not granted to any
 *     client role and are never named here.
 *   * It does not guess. An account with no username, or one that has been
 *     deleted, is simply absent from the map, and the caller decides what to
 *     say about it.
 *
 * THE PREFERRED END STATE. The right fix is server-side: `findback_my_blocks`
 * should carry the label with the row, so one round trip names the account
 * and no second read can go stale. That change is a PROPOSED DIFF in this
 * lane's handoff; this file is the honest client-side stand-in until the
 * server carries it.
 */
import { getSupabase } from "./supabaseClient";
import type { SearchedProfile } from "@norfold/shared";

type AccountIdentity = Pick<SearchedProfile, "id" | "username" | "displayName" | "avatarUrl">;
type CachedIdentity = { person: AccountIdentity; fetchedAt: number };
const identityCaches = new Map<string, Map<string, CachedIdentity>>();
const identityRequests = new Map<string, Promise<void>>();
let identityGeneration = 0;
const identityKey = (accountId: string) => `norfold.account-identities.v1:${accountId}`;

function identityCache(accountId: string): Map<string, CachedIdentity> {
  let cache = identityCaches.get(accountId);
  if (!cache) {
    cache = new Map();
    try {
      const rows: unknown = JSON.parse(localStorage.getItem(identityKey(accountId)) ?? "[]");
      if (Array.isArray(rows)) for (const row of rows.slice(-200)) {
        if (row && typeof row === "object" && typeof row.fetchedAt === "number"
          && row.person && typeof row.person.id === "string" && typeof row.person.username === "string"
          && (row.person.displayName === null || typeof row.person.displayName === "string")
          && (row.person.avatarUrl === null || typeof row.person.avatarUrl === "string")) {
          cache.set(row.person.id, row as CachedIdentity);
        }
      }
    } catch { /* Public-name caching is best effort, never a storage requirement. */ }
    identityCaches.set(accountId, cache);
  }
  return cache;
}

/** Public profile data only, scoped to the reader. Never a receipt/permission cache. */
export function readCachedAccountIdentities(accountId: string, ids: readonly string[]): Map<string, AccountIdentity> {
  const cache = identityCache(accountId);
  return new Map(ids.flatMap(id => { const row = cache.get(id); return row ? [[id, row.person] as const] : []; }));
}

/** Clear in-memory readers and fence late fetches; durable public labels survive reopening. */
export function clearAccountIdentityCache(): void {
  identityGeneration++; identityCaches.clear(); identityRequests.clear();
}

export async function fetchAccountIdentities(accountId: string, userIds: readonly string[]): Promise<Map<string, AccountIdentity>> {
  const cache = identityCache(accountId), ticket = identityGeneration;
  const ids = [...new Set(userIds.map(id => id.trim()).filter(Boolean))].sort();
  const missing = ids.filter(id => !cache.has(id) || Date.now() - cache.get(id)!.fetchedAt > 300_000);
  if (missing.length) {
    const key = JSON.stringify([accountId, missing]);
    let request = identityRequests.get(key);
    if (!request) {
      request = (async () => {
        const { data, error } = await getSupabase().from("users").select("id, username, display_name, avatar_url").in("id", missing);
        if (error) throw error;
        if (ticket !== identityGeneration) return;
        for (const row of (data ?? []) as Record<string, unknown>[]) {
          if (typeof row.id !== "string" || typeof row.username !== "string" || !row.username.trim()) continue;
          cache.set(row.id, { fetchedAt: Date.now(), person: { id: row.id, username: row.username.trim(),
            displayName: typeof row.display_name === "string" ? row.display_name.trim() || null : null,
            avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null } });
        }
        while (cache.size > 200) cache.delete(cache.keys().next().value!);
        try { localStorage.setItem(identityKey(accountId), JSON.stringify([...cache.values()])); } catch { /* Memory cache remains usable. */ }
      })();
      identityRequests.set(key, request);
      void request.finally(() => { if (identityRequests.get(key) === request) identityRequests.delete(key); }).catch(() => undefined);
    }
    await request;
  }
  return ticket === identityGeneration ? readCachedAccountIdentities(accountId, ids) : new Map();
}

/**
 * The display label for each id, for the ids that have one.
 *
 * The map has no entry for an account that is gone or has no username — the
 * caller must handle that, because "no name" is not the same as "deleted".
 */
export async function fetchAccountLabels(userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.map((id) => id.trim()).filter((id) => id !== ""))];
  const labels = new Map<string, string>();
  if (ids.length === 0) return labels;

  const { data, error } = await getSupabase()
    .from("users")
    .select("id, username")
    .in("id", ids);
  if (error) throw error;
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const username = typeof row.username === "string" ? row.username.trim() : "";
    if (id === "" || username === "") continue;
    labels.set(id, username);
  }
  return labels;
}
