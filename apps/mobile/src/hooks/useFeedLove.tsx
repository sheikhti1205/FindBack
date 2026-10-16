import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PostItem, ReactionKind, ReactionSummary } from "@findback/shared";
import {
  applyCountDeltas,
  likeMine,
  likeState,
  likeToggleDeltas,
  nextLikeReaction,
  reactionMoveDeltas,
  reactionSummaryFromCounts,
} from "../services/reactions";
import {
  fetchFeedReactionState,
  likeBucketDeltas,
  seedSummaryFromItem,
  toggleLikeReaction,
  type FeedReactionEntry,
} from "../services/feedReactions";

/**
 * Home-feed Like state (packet `08` §2 — Like-only).
 *
 * One provider per feed hydrates the caller's own reaction for every visible
 * card with a SINGLE batch RPC (chunked <=20 by the service) — card buttons
 * never call the per-card `fetchSocialState`. A Like tap updates optimistically
 * AND patches the feed cache item (via `useFeed.patchItem`) so Detail→Back
 * navigation shows the fresh counts.
 *
 * Live counts are read from the `items` prop on every render, so callers must
 * re-render with the patched items — `useFeed.patchItem` triggers exactly
 * that through its own state.
 */

export type FeedPatchItem = (id: string, patch: Partial<PostItem>) => void;

interface FeedLoveContextValue {
  reactions: Record<string, FeedReactionEntry>;
  pendingMap: Record<string, boolean>;
  itemsById: Map<string, PostItem>;
  togglePost: (postId: string) => Promise<boolean>;
}

const FeedLoveContext = createContext<FeedLoveContextValue | null>(null);

function uniqueIds(items: readonly PostItem[]): string[] {
  return [...new Set(items.map((p) => p.id).filter((id) => id !== ""))];
}

/**
 * Reconcile a summary that was captured before the caller's own row moved with
 * the caller's fresher reaction (batch hydration, or the write that just
 * landed). The feed item's `reactionSummary` was taken at fetch time, so it
 * still counts the caller's old row — applying the move on top keeps the
 * displayed count and the heart in agreement instead of showing a number that
 * silently excludes the caller (or includes a row they just cleared).
 *
 * A no-op move (both sides normalize to the same bucket) returns the base
 * object untouched, so the common path allocates nothing.
 */
function reconcileOwnedRow(
  base: ReactionSummary | null,
  mine: ReactionKind | null,
): ReactionSummary | null {
  if (!base) return null;
  const deltas = reactionMoveDeltas(base.myReaction, mine);
  if (Object.keys(deltas).length === 0) return base;
  return reactionSummaryFromCounts(applyCountDeltas(base.counts, deltas), mine);
}

export function FeedLoveProvider({
  items,
  patchItem,
  children,
}: {
  items: readonly PostItem[];
  patchItem: FeedPatchItem;
  children: ReactNode;
}) {
  const [reactions, setReactions] = useState<Record<string, FeedReactionEntry>>({});
  const [pendingMap, setPendingMap] = useState<Record<string, boolean>>({});
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const reactionsRef = useRef(reactions);
  reactionsRef.current = reactions;
  const pendingRef = useRef<Set<string>>(new Set());
  const generationRef = useRef(0);
  /**
   * Per-card commit counter: bumped only when a write actually returns server
   * truth. A hydration request remembers the counters it started at and skips
   * any card whose counter moved since, so a read that predates a *committed*
   * write can never overwrite it. A failed write does not bump (its rollback
   * restores the pre-write state, which a later read may legitimately update).
   */
  const committedEpochRef = useRef<Record<string, number>>({});

  const idsSig = useMemo(() => uniqueIds(items).join(""), [items]);
  const itemsById = useMemo(() => new Map(items.map((p) => [p.id, p])), [items]);

  // Batch-hydrate caller reactions for the visible page. Generation-guarded:
  // only the latest id set may write. In-flight or just-landed Like toggles win
  // over a late hydration response (per-card committed-write epochs), and a
  // hydration never drops the server summary a Like already returned.
  // Failures (offline/unauthenticated) stay silent — the feed remains usable,
  // toggles still attempt the RPC.
  useEffect(() => {
    if (idsSig === "") {
      setReactions({});
      return;
    }
    const ids = uniqueIds(itemsRef.current);
    const gen = ++generationRef.current;
    const epochsAtStart: Record<string, number> = { ...committedEpochRef.current };
    let cancelled = false;
    void (async () => {
      try {
        const fresh = await fetchFeedReactionState(ids);
        if (cancelled || gen !== generationRef.current) return;
        setReactions((prev) => {
          const next: Record<string, FeedReactionEntry> = {};
          for (const [pid, entry] of Object.entries(fresh)) {
            const committedSince =
              (committedEpochRef.current[pid] ?? 0) !== (epochsAtStart[pid] ?? 0);
            if (pendingRef.current.has(pid) || committedSince) {
              if (prev[pid]) next[pid] = prev[pid];
              continue;
            }
            const keptSummary = prev[pid]?.summary;
            next[pid] = keptSummary ? { ...entry, summary: keptSummary } : entry;
          }
          return next;
        });
      } catch {
        // Stay unhydrated; never crash the feed on social-state failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idsSig]);

  /**
   * One Like toggle for a card. Same contract as before the Like-only change:
   * in-flight is not a failure (the first request owns the outcome and its
   * message), the optimistic state is patched immediately, server truth
   * replaces it on success, and a failure rolls everything back and returns
   * false (never throws) so the button owns the message.
   */
  const togglePost = useCallback(
    async (postId: string): Promise<boolean> => {
      if (pendingRef.current.has(postId)) return true;
      const currentItem = itemsRef.current.find((p) => p.id === postId);
      const prev = reactionsRef.current[postId] ?? {
        // Before hydration lands the card's snapshot is the only statement of
        // the caller's own row, so the tap reads the same row the heart shows —
        // the two can never point in opposite directions.
        myReaction: currentItem?.reactionSummary?.myReaction ?? null,
        myRating: null,
      };
      const prevLike = currentItem?.likeCount ?? 0;
      const prevDislike = currentItem?.dislikeCount ?? 0;
      const deltas = likeBucketDeltas(prev.myReaction);
      const next = nextLikeReaction(prev.myReaction);
      // Optimistic per-kind counts, seeded from the number the card is showing
      // right now: a server summary (reconciled with the caller's own row, so
      // it cannot be off by the caller's contribution), else the card's legacy
      // buckets. The Like control then reads the same number the per-kind truth
      // will confirm.
      const displaySummary = prev.summary ?? currentItem?.reactionSummary ?? null;
      const prevSummary =
        (displaySummary ? reconcileOwnedRow(displaySummary, prev.myReaction) : null) ??
        seedSummaryFromItem(prevLike, prevDislike, prev.myReaction);
      const optimisticCounts = applyCountDeltas(prevSummary.counts, likeToggleDeltas(prev.myReaction));
      const optimisticSummary: ReactionSummary = {
        counts: optimisticCounts,
        myReaction: next,
        total: Object.values(optimisticCounts).reduce<number>((sum, n) => sum + (n ?? 0), 0),
      };
      pendingRef.current.add(postId);
      setPendingMap((p) => ({ ...p, [postId]: true }));
      setReactions((r) => ({
        ...r,
        [postId]: { myReaction: next, myRating: prev.myRating, summary: optimisticSummary },
      }));
      patchItem(postId, {
        likeCount: Math.max(0, prevLike + deltas.like),
        dislikeCount: Math.max(0, prevDislike + deltas.dislike),
      });
      try {
        const res = await toggleLikeReaction(postId, prev.myReaction);
        // Committed: this row is now the newest truth for the card, so any
        // hydration that started before this point must not overwrite it.
        committedEpochRef.current[postId] = (committedEpochRef.current[postId] ?? 0) + 1;
        setReactions((r) => ({
          ...r,
          [postId]: {
            myReaction: res.myReaction,
            myRating: r[postId]?.myRating ?? prev.myRating,
            // The RPC returns server truth per kind; keep it so the card reads
            // exact counts without a second fetch.
            ...(res.reactionCounts ? { summary: res.reactionCounts } : {}),
          },
        }));
        patchItem(postId, {
          likeCount: res.likeCount,
          dislikeCount: res.dislikeCount,
        });
        return true;
      } catch {
        setReactions((r) => ({ ...r, [postId]: prev }));
        patchItem(postId, {
          likeCount: prevLike,
          dislikeCount: prevDislike,
        });
        return false;
      } finally {
        pendingRef.current.delete(postId);
        setPendingMap((p) => {
          const nextPending = { ...p };
          delete nextPending[postId];
          return nextPending;
        });
      }
    },
    [patchItem],
  );

  const value = useMemo(
    () => ({ reactions, pendingMap, itemsById, togglePost }),
    [reactions, pendingMap, itemsById, togglePost],
  );
  return <FeedLoveContext.Provider value={value}>{children}</FeedLoveContext.Provider>;
}

export interface FeedLove {
  /** Caller's own reaction (raw wire kind; LIKE reads as its canonical LOVE). */
  myReaction: ReactionKind | null;
  /**
   * Per-kind summary with the caller's own row applied (reconciled against
   * `myReaction`), or null until any summary is known — then the card shows the
   * legacy `likeCount` column.
   */
  summary: ReactionSummary | null;
  /** The Like count the card shows: positive kinds once known, else the legacy like column. */
  likeCount: number;
  /** Whether the caller holds any positive reaction. */
  mine: boolean;
  /** True when the toggle landed (or was already in flight — the first request owns the outcome); false only on failure (already rolled back). */
  pending: boolean;
  toggle: () => Promise<boolean>;
}

/** Null outside a provider — callers (the Like button) fall back to local state. */
export function useFeedLove(postId: string): FeedLove | null {
  const ctx = useContext(FeedLoveContext);
  if (!ctx) return null;
  const item = ctx.itemsById.get(postId);
  const entry = ctx.reactions[postId];
  // Hydration writes an entry for every id it was asked about, so an entry that
  // exists is authoritative for the caller's own row — including when that row
  // is `null` ("no reaction"). It must never fall through to the summary
  // snapshot, which is frozen at feed-fetch time and still describes the row as
  // it was then; doing so shows a filled heart the tap would then contradict.
  const hydrated = entry !== undefined;
  const baseSummary = entry?.summary ?? item?.reactionSummary ?? null;
  const myReaction = hydrated ? entry.myReaction : (baseSummary?.myReaction ?? null);
  const summary = reconcileOwnedRow(baseSummary, myReaction);
  return {
    myReaction,
    summary,
    likeCount: summary ? likeState(summary).count : (item?.likeCount ?? 0),
    mine: likeMine(myReaction),
    pending: ctx.pendingMap[postId] ?? false,
    toggle: () => ctx.togglePost(postId),
  };
}
