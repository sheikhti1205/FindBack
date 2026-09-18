import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedPage, PostItem } from "@findback/shared";
import { fetchFeed, type FeedFilters } from "../services/posts";
import { friendlyError } from "../utils/friendlyErrors";
import { feedFilterKey, loadFeedCache, saveFeedCache } from "./feedCache";

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
  const { cacheKey: baseCacheKey, scrollRef } = options;
  const filterKey = feedFilterKey(filters);
  const cacheKey = baseCacheKey ? `${baseCacheKey}:${filterKey}` : undefined;
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
  const restoredScrollRef = useRef<string | null>(null);
  const latestRef = useRef({ items, total, cursor: cursorRef.current });
  latestRef.current = { items, total, cursor: cursorRef.current };

  // Changing filter starts a new fetch: restore per-filter cache or reset.
  const prevCacheKeyRef = useRef(cacheKey);
  useEffect(() => {
    if (prevCacheKeyRef.current === cacheKey) return;
    prevCacheKeyRef.current = cacheKey;
    // Invalidate any in-flight request for the previous filter so a late
    // response cannot overwrite the newly selected (possibly cached) feed.
    generationRef.current += 1;
    restoredScrollRef.current = null;
    cursorRef.current = null;
    if (cacheKey) {
      const cached = loadFeedCache(cacheKey);
      if (cached) {
        cursorRef.current = cached.cursor;
        setItems(cached.items);
        setTotal(cached.total);
        setError(null);
        setLoading(false);
        setLoadingMore(false);
        return;
      }
    }
    setItems([]);
    setTotal(0);
    setError(null);
  }, [cacheKey]);

  // Restore scroll position exactly once per cache key, once the cached items
  // are actually rendered. Pagination must not re-run this or the user jumps.
  useEffect(() => {
    if (!cacheKey || restoredScrollRef.current === cacheKey) return;
    const el = scrollRef?.current;
    if (!el) return;
    const cached = loadFeedCache(cacheKey);
    // Wait until the rendered items are the cached array before restoring.
    if (cached && cached.items.length > 0 && cached.items !== items) return;
    restoredScrollRef.current = cacheKey;
    if (cached && cached.scrollTop > 0) el.scrollTop = cached.scrollTop;
  }, [cacheKey, items]);

  // Persist the feed for Detail→Back. The cleanup runs on unmount and whenever
  // the cache key changes, so it always writes the latest state for that key.
  useEffect(() => {
    if (!cacheKey) return;
    return () => {
      const el = scrollRef?.current;
      saveFeedCache(cacheKey, {
        items: latestRef.current.items,
        total: latestRef.current.total,
        cursor: latestRef.current.cursor,
        scrollTop: el?.scrollTop ?? 0,
      });
    };
  }, [cacheKey]);

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
        // Keep the initial full filtered total stable: keyset follow-up
        // pages carry a page-relative count, so appends must never overwrite it.
        if (!append) setTotal(page.total);
        cursorRef.current = page.nextCursor;
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      } catch (err) {
        if (gen !== generationRef.current) return;
        setError(friendlyError(err).message);
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
  }, [cacheKey, filterKey, load]);

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