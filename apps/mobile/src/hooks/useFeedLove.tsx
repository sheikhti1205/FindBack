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
import { nextReactionForTap, normalizeReactionKind } from "../services/reactions";
import {
  applyReactionDeltas,
  fetchFeedReactionState,
  legacyCountDeltas,
  loveToggleDeltas,
  nextLoveReaction,
  seedSummaryFromItem,
  toggleLoveReaction,
  togglePostReactionKind,
  type FeedReactionEntry,
} from "../services/feedReactions";

/**
 * Home-feed Love state (UXN-2).
 *
 * One provider per feed hydrates the caller's own reaction for every visible
 * card with a SINGLE batch RPC (chunked <=20 by the service) — card buttons
 * never call the per-card `fetchSocialState`. Love toggles update
 * optimistically AND patch the feed cache item (via `useFeed.patchItem`) so
 * Detail→Back navigation shows the fresh counts.
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
  reactToKind: (postId: string, kind: ReactionKind) => Promise<boolean>;
}

const FeedLoveContext = createContext<FeedLoveContextValue | null>(null);

function uniqueIds(items: readonly PostItem[]): string[] {
  return [...new Set(items.map((p) => p.id).filter((id) => id !== ""))];
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

  const idsSig = useMemo(() => uniqueIds(items).join(""), [items]);
  const itemsById = useMemo(() => new Map(items.map((p) => [p.id, p])), [items]);

  // Batch-hydrate caller reactions for the visible page. Generation-guarded:
  // only the latest id set may write. In-flight Love toggles win over a late
  // hydration response. Failures (offline/unauthenticated) stay silent — the
  // feed remains usable and unloved, toggles still attempt the RPC.
  useEffect(() => {
    if (idsSig === "") {
      setReactions({});
      return;
    }
    const ids = uniqueIds(itemsRef.current);
    const gen = ++generationRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const fresh = await fetchFeedReactionState(ids);
        if (cancelled || gen !== generationRef.current) return;
        setReactions((prev) => {
          const next = { ...fresh };
          for (const pid of pendingRef.current) {
            if (prev[pid]) next[pid] = prev[pid];
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

  const togglePost = useCallback(
    async (postId: string): Promise<boolean> => {
      // In-flight is NOT a failure: the first request still owns the outcome
      // (and its failure message, if it comes). Report handled so a rapid
      // second tap stays a silent no-op instead of a false "Couldn't save".
      if (pendingRef.current.has(postId)) return true;
      const prev = reactionsRef.current[postId] ?? {
        myReaction: null as ReactionKind | null,
        myRating: null,
      };
      const currentItem = itemsRef.current.find((p) => p.id === postId);
      const prevLike = currentItem?.likeCount ?? 0;
      const prevDislike = currentItem?.dislikeCount ?? 0;
      const deltas = loveToggleDeltas(prev.myReaction);
      pendingRef.current.add(postId);
      setPendingMap((p) => ({ ...p, [postId]: true }));
      const optimistic: FeedReactionEntry = {
        myReaction: nextLoveReaction(prev.myReaction),
        myRating: prev.myRating,
      };
      setReactions((r) => ({ ...r, [postId]: optimistic }));
      patchItem(postId, {
        likeCount: Math.max(0, prevLike + deltas.like),
        dislikeCount: Math.max(0, prevDislike + deltas.dislike),
      });
      try {
        const res = await toggleLoveReaction(postId, prev.myReaction);
        setReactions((r) => ({
          ...r,
          [postId]: {
            myReaction: res.myReaction,
            myRating: r[postId]?.myRating ?? prev.myRating,
            // The widened RPC returns server truth per kind; keep it so the
            // tray/total read exact counts without a per-card refetch.
            ...(res.reactionCounts ? { summary: res.reactionCounts } : {}),
          },
        }));
        patchItem(postId, {
          likeCount: res.likeCount,
          dislikeCount: res.dislikeCount,
          ...(res.reactionCounts ? { reactionSummary: res.reactionCounts } : {}),
        });
        return true;
      } catch {
        setReactions((r) => ({ ...r, [postId]: prev }));
        patchItem(postId, { likeCount: prevLike, dislikeCount: prevDislike });
        // False (not a throw): the optimistic update is already rolled back,
        // and the caller (Love button) owns the failure message + announcement.
        return false;
      } finally {
        pendingRef.current.delete(postId);
        setPendingMap((p) => {
          const next = { ...p };
          delete next[postId];
          return next;
        });
      }
    },
    [patchItem],
  );

  /**
   * Kind-aware write for the reaction tray (W3.3). Same in-flight/rollback
   * contract as `togglePost`: optimistic myReaction + per-kind summary (seeded
   * from the feed item's legacy counts) + exact legacy-bucket patch, server
   * summary stored on success, full rollback + false on failure.
   */
  const reactToKind = useCallback(
    async (postId: string, kind: ReactionKind): Promise<boolean> => {
      if (pendingRef.current.has(postId)) return true;
      const prev: FeedReactionEntry = reactionsRef.current[postId] ?? {
        myReaction: null,
        myRating: null,
      };
      const currentItem = itemsRef.current.find((p) => p.id === postId);
      const prevLike = currentItem?.likeCount ?? 0;
      const prevDislike = currentItem?.dislikeCount ?? 0;
      const prevItemSummary = currentItem?.reactionSummary ?? null;
      const prevSummary =
        prev.summary ?? seedSummaryFromItem(prevLike, prevDislike, prev.myReaction);
      const next = nextReactionForTap(prev.myReaction, kind);
      const legacy = legacyCountDeltas(prev.myReaction, next);
      const optimisticCounts = applyReactionDeltas(prevSummary.counts, prev.myReaction, next);
      const optimisticSummary: ReactionSummary = {
        counts: optimisticCounts,
        myReaction: next,
        total: Object.values(optimisticCounts).reduce<number>((s, n) => s + (n ?? 0), 0),
      };
      pendingRef.current.add(postId);
      setPendingMap((p) => ({ ...p, [postId]: true }));
      setReactions((r) => ({
        ...r,
        [postId]: { myReaction: next, myRating: prev.myRating, summary: optimisticSummary },
      }));
      patchItem(postId, {
        likeCount: Math.max(0, prevLike + legacy.like),
        dislikeCount: Math.max(0, prevDislike + legacy.dislike),
        reactionSummary: optimisticSummary,
      });
      try {
        const res = await togglePostReactionKind(postId, prev.myReaction, kind);
        setReactions((r) => ({
          ...r,
          [postId]: {
            myReaction: res.myReaction,
            myRating: r[postId]?.myRating ?? prev.myRating,
            summary: res,
          },
        }));
        patchItem(postId, { reactionSummary: res });
        return true;
      } catch {
        setReactions((r) => ({ ...r, [postId]: prev }));
        patchItem(postId, {
          likeCount: prevLike,
          dislikeCount: prevDislike,
          reactionSummary: prevItemSummary ?? undefined,
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
    () => ({ reactions, pendingMap, itemsById, togglePost, reactToKind }),
    [reactions, pendingMap, itemsById, togglePost, reactToKind],
  );
  return <FeedLoveContext.Provider value={value}>{children}</FeedLoveContext.Provider>;
}

export interface FeedLove {
  /** Caller's own reaction (raw wire kind; LIKE reads as LOVE for display). */
  myReaction: ReactionKind | null;
  /** Display kind (LIKE normalized to LOVE); null when unreacted. */
  myKind: ReactionKind | null;
  /** Per-kind summary once known (batch hydration carries none — see below). */
  summary: ReactionSummary | null;
  /** Server-truth total when a summary is known, else the feed item count. */
  total: number;
  /** Live like count from the feed items (patched optimistically on toggle). */
  likeCount: number;
  pending: boolean;
  /** True when the toggle landed (or was already in flight — the first request owns the outcome); false only on failure (already rolled back). */
  toggle: () => Promise<boolean>;
  /** Tray write path: set `kind` (or unreact when it is active). Same boolean contract as `toggle`. */
  react: (kind: ReactionKind) => Promise<boolean>;
}

/** Null outside a provider — callers (the Love button) fall back to local state. */
export function useFeedLove(postId: string): FeedLove | null {
  const ctx = useContext(FeedLoveContext);
  if (!ctx) return null;
  const item = ctx.itemsById.get(postId);
  const entry = ctx.reactions[postId];
  const myReaction = entry?.myReaction ?? null;
  const summary = entry?.summary ?? item?.reactionSummary ?? null;
  return {
    myReaction,
    myKind: myReaction === null ? null : normalizeReactionKind(myReaction),
    summary,
    total: summary?.total ?? item?.likeCount ?? 0,
    likeCount: item?.likeCount ?? 0,
    pending: ctx.pendingMap[postId] ?? false,
    toggle: () => ctx.togglePost(postId),
    react: (kind) => ctx.reactToKind(postId, kind),
  };
}
