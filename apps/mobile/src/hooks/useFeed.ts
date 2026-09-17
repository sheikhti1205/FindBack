import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedPage, PostItem } from "@findback/shared";
import { fetchFeed, type FeedFilters } from "../services/posts";
import { loadFeedCache, saveFeedCache } from "./feedCache";

export interface FeedState {
  items: PostItem[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

interface UseFeedOptions {
  /** Session cache key — enables Detail→Back scroll restore for this feed. */
  cacheKey?: string;
  /** Scroll container ref whose scrollTop is saved/restored with the cache. */
  scrollRef?: React.RefObject<{ scrollTop: number } | null>;
}

/**
 * Generation-guarded feed hook.
 *
 * Every filter/search/refresh bump the generation counter. Only the current
 * generation may replace items — stale responses from earlier generations are
 * silently discarded. This replaces the old global busy flag which could drop
 * newer requests.
 *
 * Pagination is scoped to { filterKey, generation, cursor }.
 *
 * When `cacheKey` is provided the feed participates in the per-session cache:
 * items/cursor/total/scrollTop survive Detail→Back navigation without a flash
 * or refetch.
 */
export function useFeed(filters: FeedFilters, options: UseFeedOptions = {}): FeedState {
  const { cacheKey, scrollRef } = options;
  const [items, setItems] = useState<PostItem[]>(() => {
    if (cacheKey) {
      const cached = loadFeedCache(cacheKey);
      if (cached) return cached.items;
    }
    return [];
  });
  const [total, setTotal] = useState(() => {
    if (cacheKey) return loadFeedCache(cacheKey)?.total ?? 0;
    return 0;
  });
  const [loading, setLoading] = useState(() => {
    if (cacheKey) return loadFeedCache(cacheKey) == null;
    return true;
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  if (cacheKey && cursorRef.current === null) {
    cursorRef.current = loadFeedCache(cacheKey)?.cursor ?? null;
  }
  const generationRef = useRef(0);

  const filterKey = JSON.stringify(filters);

  // Restore scroll position once the cached items are rendered.
  useEffect(() => {
    if (!cacheKey || !scrollRef?.current) return;
    const cached = loadFeedCache(cacheKey);
    if (cached && cached.scrollTop > 0) {
      scrollRef.current.scrollTop = cached.scrollTop;
    }
  }, [cacheKey, items.length]);

  // Save scroll position on unmount so Detail→Back restores it.
  useEffect(() => {
    if (!cacheKey) return;
    return () => {
      const el = scrollRef?.current;
      saveFeedCache(cacheKey, {
        items,
        total,
        cursor: cursorRef.current,
        scrollTop: el?.scrollTop ?? 0,
      });
    };
  }, [cacheKey, items, total]);

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      const gen = ++generationRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const page: FeedPage = await fetchFeed(filters, cursor ?? undefined);
        // Discard if filters/generation changed while we were fetching
        if (gen !== generationRef.current) return;
        setTotal(page.total);
        cursorRef.current = page.nextCursor;
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      } catch (err) {
        if (gen !== generationRef.current) return;
        setError(err instanceof Error ? err.message : "Could not load posts");
        if (!append) setItems([]);
      } finally {
        if (gen === generationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filterKey],
  );

  useEffect(() => {
    // When a session cache exists, restore it without a top flash/refetch.
    if (cacheKey && loadFeedCache(cacheKey)) return;
    void load(null, false);
  }, [filterKey, load]);

  const refresh = useCallback(async () => {
    cursorRef.current = null;
    await load(null, false);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (cursorRef.current) await load(cursorRef.current, true);
  }, [load]);

  return {
    items,
    total,
    loading,
    loadingMore,
    error,
    hasMore: Boolean(cursorRef.current),
    refresh,
    loadMore,
  };
}