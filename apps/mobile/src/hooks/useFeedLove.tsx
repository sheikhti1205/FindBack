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
import type { PostItem } from "@findback/shared";
import {
  fetchFeedReactionState,
  loveToggleDeltas,
  nextLoveReaction,
  toggleLoveReaction,
  type CallerReaction,
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
      if (pendingRef.current.has(postId)) return false;
      const prev = reactionsRef.current[postId] ?? {
        myReaction: null as CallerReaction,
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
          },
        }));
        patchItem(postId, { likeCount: res.likeCount, dislikeCount: res.dislikeCount });
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

  const value = useMemo(
    () => ({ reactions, pendingMap, itemsById, togglePost }),
    [reactions, pendingMap, itemsById, togglePost],
  );
  return <FeedLoveContext.Provider value={value}>{children}</FeedLoveContext.Provider>;
}

export interface FeedLove {
  myReaction: CallerReaction;
  /** Live like count from the feed items (patched optimistically on toggle). */
  likeCount: number;
  pending: boolean;
  /** True when the toggle landed; false when it failed (already rolled back). */
  toggle: () => Promise<boolean>;
}

/** Null outside a provider — callers (the Love button) fall back to local state. */
export function useFeedLove(postId: string): FeedLove | null {
  const ctx = useContext(FeedLoveContext);
  if (!ctx) return null;
  const item = ctx.itemsById.get(postId);
  return {
    myReaction: ctx.reactions[postId]?.myReaction ?? null,
    likeCount: item?.likeCount ?? 0,
    pending: ctx.pendingMap[postId] ?? false,
    toggle: () => ctx.togglePost(postId),
  };
}
