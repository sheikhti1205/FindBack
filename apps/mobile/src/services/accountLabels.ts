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
