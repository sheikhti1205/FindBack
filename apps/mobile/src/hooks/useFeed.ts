import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedPage, PostItem } from "@findback/shared";
import { fetchFeed, type FeedFilters } from "../services/posts";
import { friendlyError } from "../utils/friendlyErrors";
import { recordLoadTiming } from "../utils/loadTiming";
import { feedFilterKey, loadFeedCache, saveFeedCache } from "./feedCache";

export interface FeedState {
  items: PostItem[];
  total: number;
  /** Cold load with no visible items. Stays false during background refresh. */
  loading: boolean;
  /** Background refresh with visible items preserved. */
  refreshing: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Reconcile a deleted post in place — never refetch or reorder the list. */
  removeItem: (id: string) => void;
  /**
   * UXN-2: merge a partial patch into one loaded item in place (e.g.
   * optimistic Love counts) — never refetch or reorder. The patched items
   * flow into the Detail→Back session snapshot on unmount like any load.
   */
  patchItem: (id: string, patch: Partial<PostItem> | ((prev: PostItem) => Partial<PostItem>)) => void;
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
 * A non-append load with visible items is a background `refreshing` pass:
 * items stay on screen until the current generation reconciles them. A
 * non-append load with no visible items is a cold `loading` pass. A failed
 * refresh preserves the visible items; only a failed cold load clears them.
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
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  if (cacheKey && cursorRef.current === null) {
    cursorRef.current = loadFeedCache(cacheKey)?.cursor ?? null;
  }
  const generationRef = useRef(0);
  const loadedRef = useRef(false);
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
        loadedRef.current = true;
        setItems(cached.items);
        setTotal(cached.total);
        setError(null);
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
        return;
      }
    }
    loadedRef.current = false;
    setItems([]);
    setTotal(0);
    setRefreshing(false);
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
  // Skip an empty never-loaded snapshot so an early unmount cannot pin an
  // empty artifact that would suppress the next mount's fetch.
  //
  // `scrollRef` itself is unusable here: React detaches it — `current` becomes
  // null — before this cleanup runs, which wrote scrollTop 0 and sent the
  // reader to the top of the feed on the way back from a post (measured). The
  // handle OBJECT survives the detach, and `PullToRefresh` remembers the last
  // position it saw inside it, so keep the handle itself while it is alive.
  const handleRef = useRef<{ scrollTop: number } | null>(null);
  useEffect(() => {
    if (scrollRef?.current) handleRef.current = scrollRef.current;
  });

  useEffect(() => {
    if (!cacheKey) return;
    return () => {
      if (!loadedRef.current && latestRef.current.items.length === 0) return;
      const el = handleRef.current ?? scrollRef?.current;
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
      // A non-append load over visible items is a background refresh: keep
      // the items on screen and reconcile atomically when this generation
      // resolves. Only an empty list takes the cold-loading path.
      const isRefresh = !append && latestRef.current.items.length > 0;
      if (append) setLoadingMore(true);
      else if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      const startedAt = Date.now();
      try {
        const page: FeedPage = await fetchFeed(filters, cursor ?? undefined);
        recordLoadTiming("feed", Date.now() - startedAt);
        // Discard if filters/generation changed while we were fetching
        if (gen !== generationRef.current) return;
        loadedRef.current = true;
        // Keep the initial full filtered total stable: keyset follow-up
        // pages carry a page-relative count, so appends must never overwrite it.
        if (!append) setTotal(page.total);
        cursorRef.current = page.nextCursor;
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      } catch (err) {
        recordLoadTiming("feed", Date.now() - startedAt);
        if (gen !== generationRef.current) return;
        setError(friendlyError(err).message);
        // A failed refresh keeps the visible items; only a failed cold load
        // clears the list.
        if (!append && !isRefresh) setItems([]);
      } finally {
        if (gen === generationRef.current) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [filterKey],
  );

  useEffect(() => {
    // Restore a fresh session cache without a top flash/refetch. A dirty cache
    // (a realtime INSERT arrived while this feed was unmounted) still restores
    // the visible items instantly, then refreshes in the background.
    const cached = cacheKey ? loadFeedCache(cacheKey) : null;
    if (cached && !cached.dirty) return;
    void load(null, false);
  }, [cacheKey, filterKey, load]);

  const refresh = useCallback(async () => {
    cursorRef.current = null;
    await load(null, false);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (cursorRef.current) await load(cursorRef.current, true);
  }, [load]);

  // A realtime delete must not yank or reorder a scrolled reader: drop the row
  // where it sits and keep every other item in place. If the post is not
  // loaded, this is a no-op.
  const removeItem = useCallback((id: string) => {
    if (!latestRef.current.items.some((item) => item.id === id)) return;
    setItems((prev) => prev.filter((item) => item.id !== id));
    setTotal((t) => Math.max(0, t - 1));
  }, []);

  // An optimistic patch (e.g. Love counts) must not yank or reorder a
  // scrolled reader: merge into the row where it sits and keep every other
  // item in place. If the post is not loaded, this is a no-op. Totals are
  // untouched — a patch never adds or removes rows.
  const patchItem = useCallback(
    (id: string, patch: Partial<PostItem> | ((prev: PostItem) => Partial<PostItem>)) => {
      if (!latestRef.current.items.some((item) => item.id === id)) return;
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, ...(typeof patch === "function" ? patch(item) : patch) } : item,
        ),
      );
    },
    [],
  );

  return {
    items,
    total,
    loading,
    refreshing,
    loadingMore,
    error,
    hasMore: Boolean(cursorRef.current),
    refresh,
    loadMore,
    removeItem,
    patchItem,
  };
}