import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedPage, PostItem } from "@findback/shared";
import { fetchFeed, type FeedFilters } from "../services/posts";

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

/**
 * Generation-guarded feed hook.
 *
 * Every filter/search/refresh bump the generation counter. Only the current
 * generation may replace items — stale responses from earlier generations are
 * silently discarded. This replaces the old global busy flag which could drop
 * newer requests.
 *
 * Pagination is scoped to { filterKey, generation, cursor }.
 */
export function useFeed(filters: FeedFilters): FeedState {
  const [items, setItems] = useState<PostItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  const filterKey = JSON.stringify(filters);

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
