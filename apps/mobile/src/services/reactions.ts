import type {
  CanonicalReactionKind,
  ReactionCounts,
  ReactionKind,
  ReactionSummary,
} from "@findback/shared";
import { CANONICAL_REACTION_KINDS, LEGACY_REACTION_KINDS } from "@findback/shared";
import { ApiError } from "./session";
import { getSupabase } from "./supabaseClient";

/**
 * FindBack reactions — backend/service layer, no UI.
 *
 * The stored vocabulary is LOVE / HELPFUL / SUPPORT / WOW with legacy
 * LIKE/DISLIKE still valid on the wire. Since packet `08` §2 the **UI writes
 * Like-only**: a Like writes `LIKE` (which the SQL folds to LOVE for every
 * count it returns) and clears with null. The four canonical kinds remain the
 * keying for counts and the labelling of historical rows, so legacy
 * notification/inbox rows still render consistently; nothing here presents a
 * picker any more.
 *
 * The RPCs are the existing `findback_react_client` (post) and the new
 * `findback_react_comment_client` (comment); both return per-kind counts plus
 * the caller's own reaction. There is deliberately no exported writer that
 * accepts an arbitrary kind: the post path goes through
 * `reactToPost(id, nextLikeReaction(current))` and the comment path through
 * `setCommentReaction`, so "new writes are LIKE or null only" is structural
 * rather than a convention callers have to remember.
 */

export type { ReactionCounts, ReactionKind, ReactionSummary } from "@findback/shared";

/** Every valid wire kind, canonical first then legacy. */
export const ALL_REACTION_KINDS: readonly ReactionKind[] = [
  ...CANONICAL_REACTION_KINDS,
  ...LEGACY_REACTION_KINDS,
];

export interface ReactionKindMeta {
  kind: CanonicalReactionKind;
  label: string;
  /**
   * Canonical system-emoji presentation for the kind, rendered by the
   * platform emoji font. THE ONE mapping for historical notification/inbox
   * rows (the Like-only UI no longer presents reaction art) — never
   * per-screen dialects.
   */
  emoji: string;
  /**
   * Legacy semantic icon name (pre-emoji custom-art era). Deprecated: kept
   * so old persisted references resolve; new code must use `emoji`.
   */
  glyph: string;
}

/**
 * THE ONE canonical reaction presentation map (owner directive 2026-10-14):
 * backend kinds LOVE / HELPFUL / SUPPORT / WOW are unchanged — only
 * presentation moves from custom SVG art to platform system-emoji glyphs.
 */
export const REACTION_EMOJI: Record<CanonicalReactionKind, string> = {
  LOVE: "❤️",
  HELPFUL: "💡",
  SUPPORT: "🤝",
  WOW: "😮",
};

/**
 * Ordered metadata for the four canonical kinds. `emoji` is the canonical
 * system-emoji char; `glyph` is the deprecated semantic name from the
 * custom-art era.
 */
export const REACTION_KINDS: readonly ReactionKindMeta[] = [
  { kind: "LOVE", label: "Love", emoji: REACTION_EMOJI.LOVE, glyph: "heart" },
  { kind: "HELPFUL", label: "Helpful", emoji: REACTION_EMOJI.HELPFUL, glyph: "lightbulb" },
  { kind: "SUPPORT", label: "Support", emoji: REACTION_EMOJI.SUPPORT, glyph: "hand-heart" },
  { kind: "WOW", label: "Wow", emoji: REACTION_EMOJI.WOW, glyph: "sparkles" },
];

/**
 * Canonical system-emoji char for any wire kind (legacy LIKE reads as LOVE);
 * null when the kind has no canonical presentation (e.g. DISLIKE/unknown).
 * Notification/inbox rows use this so legacy rows still render consistently.
 */
export function reactionEmojiForWire(kind: ReactionKind | null): string | null {
  if (kind === null) return null;
  const canonical = normalizeReactionKind(kind);
  if (!isReactionKind(canonical)) return null;
  return (REACTION_EMOJI as Partial<Record<ReactionKind, string>>)[canonical] ?? null;
}

/**
 * THE ONE Like rule (packet `08` §2, "reactions become Like-only").
 *
 * A Like is a positive reaction, so a target's Like count is every
 * LOVE/HELPFUL/SUPPORT/WOW row it has; the SQL folds legacy LIKE rows into
 * LOVE, so history keeps counting. A legacy DISLIKE is **not** a like: it never
 * counts and never fills the control. It stays **readable** as history — the
 * "not helpful" count and the reader's own old DISLIKE row are still shown —
 * but the client has no writer for it any more (D1), so it can only come from
 * rows that already exist. "Mine" is true when the caller holds *any* positive
 * reaction, so a reader who once reacted with Helpful sees a filled Like and
 * tapping it clears their row (one row per caller per target is the RPC's
 * contract — a legacy DISLIKE row is replaced by the LIKE).
 *
 * New writes are `LIKE` or null only (packet §2). Everything here is derived
 * from the canonical counts, so no surface can show a Like total that disagrees
 * with the per-kind truth the server returned.
 */
export const LIKE_KINDS: readonly CanonicalReactionKind[] = CANONICAL_REACTION_KINDS;

export interface LikeState {
  /** Positive reactions on the target (legacy LIKE rows live in the LOVE bucket). */
  count: number;
  /** Whether the caller holds any positive reaction. */
  mine: boolean;
}

/**
 * The caller's Like state from their own wire kind: any positive kind is a
 * Like, DISLIKE and null are not. Legacy LIKE reads as its canonical LOVE.
 */
export function likeMine(current: ReactionKind | null): boolean {
  if (current === null) return false;
  return (LIKE_KINDS as readonly ReactionKind[]).includes(normalizeReactionKind(current));
}

/** The wire kind a Like tap writes: `LIKE` to set it, null to clear the caller's row. */
export function nextLikeReaction(current: ReactionKind | null): ReactionKind | null {
  return likeMine(current) ? null : "LIKE";
}

/** Per-kind optimistic count deltas for moving `current` → `next` (null = no reaction). */
export function reactionMoveDeltas(
  current: ReactionKind | null,
  next: ReactionKind | null,
): ReactionCounts {
  const deltas: ReactionCounts = {};
  const bump = (kind: ReactionKind, delta: number) => {
    const key = normalizeReactionKind(kind);
    deltas[key] = (deltas[key] ?? 0) + delta;
  };
  if (current !== null) bump(current, -1);
  if (next !== null) bump(next, 1);
  for (const key of Object.keys(deltas) as ReactionKind[]) {
    if (deltas[key] === 0) delete deltas[key];
  }
  return deltas;
}

/** Per-kind optimistic count deltas for a Like tap on a target where the caller holds `current`. */
export function likeToggleDeltas(current: ReactionKind | null): ReactionCounts {
  return reactionMoveDeltas(current, nextLikeReaction(current));
}

/** Apply per-kind deltas to canonical counts, dropping buckets that reach zero. */
export function applyCountDeltas(counts: ReactionCounts, deltas: ReactionCounts): ReactionCounts {
  const patched: ReactionCounts = { ...counts };
  for (const [rawKind, delta] of Object.entries(deltas)) {
    // A non-finite delta (bad server/optimistic input) must never poison a
    // count the Like control renders.
    if (!Number.isFinite(delta)) continue;
    if (!isReactionKind(rawKind)) continue;
    const key = normalizeReactionKind(rawKind);
    const value = (patched[key] ?? 0) + (delta ?? 0);
    if (value <= 0) delete patched[key];
    else patched[key] = value;
  }
  return patched;
}

/** The Like count and the caller's own state, derived from a summary's counts. */
export function likeState(summary: ReactionSummary): LikeState {
  return {
    count: LIKE_KINDS.reduce((sum, kind) => sum + (summary.counts[kind] ?? 0), 0),
    mine: likeMine(summary.myReaction),
  };
}

/**
 * Consumer label for a canonical kind, for legacy rows that still name the
 * reaction a reader gave ("reacted to your report with Love") — never a raw
 * enum. Null when the kind has no canonical presentation (DISLIKE/unknown/
 * absent), so callers can skip the clause entirely.
 */
export function reactionKindLabel(kind: ReactionKind | null): string | null {
  if (kind === null) return null;
  const canonical = normalizeReactionKind(kind);
  return REACTION_KINDS.find((meta) => meta.kind === canonical)?.label ?? null;
}

export function isReactionKind(value: unknown): value is ReactionKind {
  return typeof value === "string" && (ALL_REACTION_KINDS as readonly string[]).includes(value);
}

/** Legacy LIKE is the canonical Love; every other kind is its own canonical. */
export function normalizeReactionKind(kind: ReactionKind): ReactionKind {
  return kind === "LIKE" ? "LOVE" : kind;
}

/** Coerce a PostgREST jsonb count object into canonical-keyed counts. */
export function reactionCountsFromJson(value: unknown): ReactionCounts {
  const counts: ReactionCounts = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return counts;
  for (const [rawKey, rawCount] of Object.entries(value as Record<string, unknown>)) {
    if (!isReactionKind(rawKey)) continue;
    const n = typeof rawCount === "number" ? rawCount : Number(rawCount);
    if (!Number.isFinite(n) || n <= 0) continue;
    const key = normalizeReactionKind(rawKey);
    counts[key] = (counts[key] ?? 0) + n;
  }
  return counts;
}

/**
 * Aggregate reaction rows (e.g. `{ type }` rows) into a `ReactionSummary`,
 * folding LIKE into LOVE. Unknown types are ignored so the total stays honest.
 */
export function summarizeReactions(
  rows: readonly { type: string }[],
  myReaction: ReactionKind | null = null,
): ReactionSummary {
  const counts: ReactionCounts = {};
  for (const row of rows) {
    if (!isReactionKind(row.type)) continue;
    const key = normalizeReactionKind(row.type);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return reactionSummaryFromCounts(counts, myReaction);
}

/**
 * THE ONE counts→summary aggregator (L-CONSOLIDATE): every surface that
 * holds canonical per-kind counts plus the caller's own reaction builds its
 * `ReactionSummary` here, so totals can never disagree with the counts.
 * `summarizeReactions`, `reactionSummaryFromRow`, and the PostDetail
 * realtime/optimistic paths all delegate — the feed `seedSummaryFromItem`
 * shim stays separate INTENTIONALLY (legacy buckets, no server counts).
 */
export function reactionSummaryFromCounts(
  counts: ReactionCounts,
  myReaction: ReactionKind | null,
): ReactionSummary {
  const merged: ReactionCounts = {};
  for (const [rawKey, rawCount] of Object.entries(counts)) {
    if (!isReactionKind(rawKey)) continue;
    const n = typeof rawCount === "number" ? rawCount : Number(rawCount);
    if (!Number.isFinite(n) || n <= 0) continue;
    const key = normalizeReactionKind(rawKey);
    merged[key] = (merged[key] ?? 0) + n;
  }
  return {
    counts: merged,
    myReaction: myReaction === null ? null : normalizeReactionKind(myReaction),
    total: totalOf(merged),
  };
}

function totalOf(counts: ReactionCounts): number {
  return Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
}

function assertKind(kind: ReactionKind | null): void {
  if (kind !== null && !isReactionKind(kind)) {
    throw new ApiError("Unknown reaction", 400);
  }
}

/**
 * Guard for the client reaction WRITERS (D1).
 *
 * A legacy DISLIKE row stays readable as history, but the app has no surface
 * that writes one — the "not helpful" control was removed and the rating
 * writer is gone. The writers therefore reject the kind outright, so no
 * caller can resurrect the negative write path by passing the token through.
 */
export function assertWritableReactionKind(kind: ReactionKind | null): void {
  assertKind(kind);
  if (kind === "DISLIKE") {
    throw new ApiError("Unknown reaction", 400);
  }
}

interface CommentReactionRow {
  comment_id?: unknown;
  my_reaction?: unknown;
  reaction_counts?: unknown;
}

export interface CommentReactionSummary extends ReactionSummary {
  commentId: string;
}

/** Set (or clear, with null) the caller's comment reaction; returns the summary. */
export async function setCommentReaction(
  commentId: string,
  kind: ReactionKind | null,
): Promise<CommentReactionSummary> {
  assertWritableReactionKind(kind);
  const { data, error } = await getSupabase().rpc("findback_react_comment_client", {
    p_comment_id: commentId,
    p_type: kind,
  });
  if (error) throw new ApiError(error.message, 400);
  const row = ((data ?? []) as CommentReactionRow[])[0];
  if (!row) throw new ApiError("Reaction was not saved", 400);
  const counts = reactionCountsFromJson(row.reaction_counts);
  const myReaction = isReactionKind(row.my_reaction) ? normalizeReactionKind(row.my_reaction) : null;
  return {
    commentId: String(row.comment_id ?? commentId),
    counts,
    myReaction,
    total: totalOf(counts),
  };
}

/** Map a row carrying `reaction_counts`/`my_reaction` to a summary (absent → undefined). */
export function reactionSummaryFromRow(row: {
  reaction_counts?: unknown;
  my_reaction?: unknown;
}): ReactionSummary | undefined {
  if (row.reaction_counts === undefined && row.my_reaction === undefined) return undefined;
  return reactionSummaryFromCounts(
    reactionCountsFromJson(row.reaction_counts),
    isReactionKind(row.my_reaction) ? row.my_reaction : null,
  );
}
