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
 * Multi-kind FindBack reactions (W3.3) — backend/service layer, no UI.
 *
 * The canonical model is LOVE / HELPFUL / SUPPORT / WOW. Legacy LIKE/DISLIKE
 * stay valid on the wire and are retained: LIKE is displayed as LOVE (mapped by
 * the SQL via `case when type = 'LIKE' then 'LOVE' else type end`), DISLIKE is
 * surfaced as itself. All counts returned here are keyed by that canonical
 * kind, so callers never branch on the legacy names.
 *
 * The RPCs are the existing `findback_react_client` (post) and the new
 * `findback_react_comment_client` (comment); both return per-kind counts plus
 * the caller's own reaction.
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
  /** Icon/glyph name only — the UI maps it to its own renderer. Never an emoji. */
  glyph: string;
}

/**
 * Ordered metadata for the four canonical kinds (tap tray / picker order).
 * `glyph` is a semantic name, not an image or emoji.
 */
export const REACTION_KINDS: readonly ReactionKindMeta[] = [
  { kind: "LOVE", label: "Love", glyph: "heart" },
  { kind: "HELPFUL", label: "Helpful", glyph: "lightbulb" },
  { kind: "SUPPORT", label: "Support", glyph: "hand-heart" },
  { kind: "WOW", label: "Wow", glyph: "sparkles" },
];

/** A plain tap (no long-press tray) applies Love. */
export const DEFAULT_REACTION_KIND: ReactionKind = "LOVE";

export function isReactionKind(value: unknown): value is ReactionKind {
  return typeof value === "string" && (ALL_REACTION_KINDS as readonly string[]).includes(value);
}

/** Legacy LIKE is the canonical Love; every other kind is its own canonical. */
export function normalizeReactionKind(kind: ReactionKind): ReactionKind {
  return kind === "LIKE" ? "LOVE" : kind;
}

/**
 * Reaction for a tap on `kind` (default Love) given the caller's `current`
 * reaction: same canonical kind again → null (unreact); otherwise the tapped
 * kind. Legacy LIKE and canonical LOVE are the same kind for this decision.
 */
export function nextReactionForTap(
  current: ReactionKind | null,
  kind: ReactionKind = DEFAULT_REACTION_KIND,
): ReactionKind | null {
  const target = normalizeReactionKind(kind);
  if (current !== null && normalizeReactionKind(current) === target) return null;
  return target;
}

/**
 * Per-kind optimistic count deltas for moving `current` → `next` (null = no
 * reaction). Only non-zero deltas are present. LIKE and LOVE share one bucket.
 */
export function reactionToggleDeltas(
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

/**
 * Up to `n` canonical kinds with a positive count, best first; ties resolve
 * in canonical tray order (LOVE/HELPFUL/SUPPORT/WOW). THE ONE top-kinds
 * helper (L-CONSOLIDATE): ReactionPreviewStack imports this; ReactionTray's
 * single-best `topReactionKind` swap is reserved for the coordinator.
 */
export function topKinds(counts: ReactionCounts, n = 3): CanonicalReactionKind[] {
  return CANONICAL_REACTION_KINDS.filter((k) => (counts[k] ?? 0) > 0)
    .sort((a, b) => {
      const diff = (counts[b] ?? 0) - (counts[a] ?? 0);
      if (diff !== 0) return diff;
      return CANONICAL_REACTION_KINDS.indexOf(a) - CANONICAL_REACTION_KINDS.indexOf(b);
    })
    .slice(0, n);
}

function totalOf(counts: ReactionCounts): number {
  return Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
}

function assertKind(kind: ReactionKind | null): void {
  if (kind !== null && !isReactionKind(kind)) {
    throw new ApiError("Unknown reaction", 400);
  }
}

interface PostReactionRow {
  like_count?: unknown;
  dislike_count?: unknown;
  my_reaction?: unknown;
  reaction_counts?: unknown;
}

interface CommentReactionRow {
  comment_id?: unknown;
  my_reaction?: unknown;
  reaction_counts?: unknown;
}

/** Set (or clear, with null) the caller's post reaction; returns the summary. */
export async function setPostReaction(
  postId: string,
  kind: ReactionKind | null,
): Promise<ReactionSummary> {
  assertKind(kind);
  const { data, error } = await getSupabase().rpc("findback_react_client", {
    p_post_id: postId,
    p_type: kind,
  });
  if (error) throw new ApiError(error.message, 400);
  const row = ((data ?? []) as PostReactionRow[])[0];
  if (!row) throw new ApiError("Reaction was not saved", 400);
  const counts = reactionCountsFromJson(row.reaction_counts);
  const myReaction = isReactionKind(row.my_reaction) ? normalizeReactionKind(row.my_reaction) : null;
  return { counts, myReaction, total: totalOf(counts) };
}

export interface CommentReactionSummary extends ReactionSummary {
  commentId: string;
}

/** Set (or clear, with null) the caller's comment reaction; returns the summary. */
export async function setCommentReaction(
  commentId: string,
  kind: ReactionKind | null,
): Promise<CommentReactionSummary> {
  assertKind(kind);
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

/** Validate that `kind` is a known reaction kind (used by callers before RPCs). */
export function assertReactionKind(kind: ReactionKind | null): void {
  assertKind(kind);
}
