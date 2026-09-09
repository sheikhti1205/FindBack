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

export function useFeed(filters: FeedFilters): FeedState {
  const [items, setItems] = useState<PostItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const busyRef = useRef(false);

  const filterKey = JSON.stringify(filters);

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (busyRef.current) return;
      busyRef.current = true;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const page: FeedPage = await fetchFeed(filters, cursor ?? undefined);
        setTotal(page.total);
        cursorRef.current = page.nextCursor;
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load posts");
        if (!append) setItems([]);
      } finally {
        busyRef.current = false;
        setLoading(false);
        setLoadingMore(false);
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
