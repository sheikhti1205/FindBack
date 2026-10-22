/**
 * Blocking — the write side of a relationship the server already reads.
 *
 * THE ACT IS ONE-SIDED; THE EFFECT IS MUTUAL. A block is the caller's own
 * directional row (`user_blocks`), and every read predicate on the server is
 * the symmetric disjunction of the two directions, so blocking someone hides
 * each of you from the other in feeds, search, comment lists, report cards and
 * notifications. That is what the confirmation copy promises, and it is what
 * the server delivers (MC D16/D17).
 *
 * NOBODY LEARNS WHO BLOCKED WHOM. The block table has no client grant at all
 * (MC D18), so there is no client path that reads a direction. The two
 * surfaces this service uses are:
 *
 *   findback_my_blocks()            the caller's OWN outgoing blocks;
 *   findback_is_blocked_with_me(u)  one direction-free bit about a named user,
 *                                   computed only from rows the caller is a
 *                                   party to.
 *
 * UNBLOCKING IS PER-DIRECTION AND PER-USER (MC D22). Clearing the caller's own
 * row restores mutual visibility only when the other party has not blocked
 * them; otherwise the pair stays hidden. `unblockUser` therefore returns
 * `stillHidden`, which is exactly the same bit `isBlockedWithMe` answers —
 * never a claim about which of the two directions is still in force.
 *
 * The screens that use this (Settings → Privacy → blocked users, a profile's
 * block action, the blur/warning/reveal surface required by O5) belong to the
 * safety-UI lane; this file is the small server-shaped service only.
 */
import { getSupabase } from "./supabaseClient";
import { ApiError } from "./session";

/** One account the caller has blocked. Never a name, never a direction. */
export interface BlockedUser {
  userId: string;
  blockedAt: string;
}

/**
 * The server's refusal is an answer, not a transport failure.
 *
 *   42501  the server says "you may not do this" (403);
 *   22023  the request itself is wrong — blocking yourself, no user (400);
 *   28000  there is no signed-in account (401);
 *   P0002  the other account does not exist any more (404).
 *
 * Everything else — a missing function before the migration is applied
 * (PGRST202), a transport failure, a shape mismatch — is a server trouble and
 * must not be reported as the user's own mistake.
 */
function blockError(message: string, code?: string): ApiError {
  if (code === "42501") return new ApiError(message, 403, code);
  if (code === "22023") return new ApiError(message, 400, code);
  if (code === "28000") return new ApiError(message, 401, code);
  if (code === "P0002") return new ApiError(message, 404, code);
  return new ApiError(message, 500, code);
}

function requireUserId(userId: string): string {
  const trimmed = userId.trim();
  if (!trimmed) throw new ApiError("A user is required.", 400, "MISSING_USER_ID");
  return trimmed;
}

/** The caller's own outgoing blocks (Settings → Privacy → Blocked users). */
export async function listMyBlocks(): Promise<BlockedUser[]> {
  const { data, error } = await getSupabase().rpc("findback_my_blocks", {});
  if (error) throw blockError(error.message, error.code);
  return ((data ?? []) as Record<string, unknown>[])
    .map((row) => ({
      userId: String(row.blocked_user_id ?? ""),
      blockedAt: String(row.created_at ?? ""),
    }))
    // A row without a user id is not a block this client can name, so it is
    // dropped rather than rendered as an empty entry.
    .filter((row) => row.userId !== "");
}

/**
 * Block a user. Idempotent on the server: tapping twice is one row, and the
 * original block time is kept.
 */
export async function blockUser(userId: string): Promise<void> {
  const target = requireUserId(userId);
  const { error } = await getSupabase().rpc("findback_block_user", { p_user_id: target });
  if (error) throw blockError(error.message, error.code);
}

/**
 * Unblock a user — the caller's own direction only.
 *
 * `stillHidden` is true while a block row remains in EITHER direction, so the
 * UI can say the truth: "You've unblocked X. You still won't see each other if
 * they've blocked you." It is the same bit `isBlockedWithMe` returns, so this
 * call discloses nothing the caller could not already ask for.
 */
export async function unblockUser(userId: string): Promise<{ stillHidden: boolean }> {
  const target = requireUserId(userId);
  const { data, error } = await getSupabase().rpc("findback_unblock_user", { p_user_id: target });
  if (error) throw blockError(error.message, error.code);
  return { stillHidden: data === true };
}

/**
 * "Are this account and I blocked from each other?"
 *
 * One direction-free bit, caller-scoped: the server computes it only from rows
 * in which the caller is a party (MC §13.8). The app needs it to blur content
 * and refuse interaction; it cannot be used to ask about anybody else's pair.
 */
export async function isBlockedWithMe(userId: string): Promise<boolean> {
  const target = requireUserId(userId);
  const { data, error } = await getSupabase().rpc("findback_is_blocked_with_me", { p_other: target });
  if (error) throw blockError(error.message, error.code);
  return data === true;
}
