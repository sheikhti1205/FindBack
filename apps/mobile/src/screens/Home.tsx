import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { PostType } from "@findback/shared";
import { Segmented } from "../components/Segmented";
import { PostList } from "../components/PostList";
import { PullToRefresh, type PullToRefreshHandle } from "../components/PullToRefresh";
import { NewPostsPill } from "../components/NewPostsPill";
import { useFeed } from "../hooks/useFeed";
import { onRealtime } from "../services/realtime";
import { useAuth } from "../auth";
import { useTabTap } from "../components/TabTap";
import { buildFeedCacheKey, clearNewPostCount, getNewPostCount, incrementNewPostCount } from "../hooks/feedCache";

type TypeFilter = PostType | "ALL";

const HOME_CACHE_KEY = "home:feed";

export function Home() {
  const { user } = useAuth();
  const { tapCount } = useTabTap();
  const [type, setType] = useState<TypeFilter>("ALL");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const feedFilters: { type: "" | PostType; q: string | undefined } = {
    type: type === "ALL" ? "" : type,
    q: appliedQuery || undefined,
  };
  const scopedCacheKey = buildFeedCacheKey(HOME_CACHE_KEY, feedFilters);
  const [newPostCount, setNewPostCount] = useState(() => getNewPostCount(scopedCacheKey));
  const [hasUpdates, setHasUpdates] = useState(false);
  const scrollRef = useRef<PullToRefreshHandle>(null);

  // Debounce the search box so each keystroke does not hit the API.
  useEffect(() => {
    const t = setTimeout(() => setAppliedQuery(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);

  const { items, total, loading, loadingMore, error, hasMore, refresh, loadMore } = useFeed(
    feedFilters,
    { cacheKey: scopedCacheKey, scrollRef },
  );

  // Active Home tab tap: refresh + scroll top.
  useEffect(() => {
    if (tapCount === 0) return;
    void refresh();
    scrollRef.current?.scrollToTop();
    setNewPostCount(0);
    setHasUpdates(false);
    clearNewPostCount(scopedCacheKey);
  }, [tapCount, refresh, scopedCacheKey]);

  // Live: only new inserts increment new-posts; else show Updates. Never yank scroll.
  useEffect(() => {
    const off = onRealtime("feed:changed", (payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      const op = typeof p.op === "string" ? p.op.toUpperCase() : typeof p.type === "string" ? p.type.toUpperCase() : null;
      const isInsert = op == null || op === "INSERT" || p.isNew === true;
      const scrolled = (scrollRef.current?.scrollTop ?? 0) > 40;
      if (scrolled) {
        if (isInsert) {
          incrementNewPostCount(scopedCacheKey, 1);
          setNewPostCount(getNewPostCount(scopedCacheKey));
        } else {
          setHasUpdates(true);
        }
      } else {
        void refresh();
      }
    });
    return off;
  }, [refresh, scopedCacheKey]);

  // A post was deleted: reconcile the list in place.
  useEffect(() => {
    const off = onRealtime("post:deleted", () => {
      void refresh();
    });
    return off;
  }, [refresh]);

  useEffect(() => {
    setNewPostCount(getNewPostCount(scopedCacheKey));
    setHasUpdates(false);
  }, [scopedCacheKey]);

  function onNewPostsTap() {
    void refresh();
    scrollRef.current?.scrollToTop();
    setNewPostCount(0);
    setHasUpdates(false);
    clearNewPostCount(scopedCacheKey);
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="px-4 pt-5">
        <h1 className="text-xl font-semibold tracking-tight">FindBack</h1>
        <p className="text-xs text-on-surface-variant">
          {total} item{total === 1 ? "" : "s"} · signed in as @{user?.username}
        </p>
      </header>

      <div className="flex flex-col gap-3 px-4">
        <Segmented<TypeFilter>
          ariaLabel="Post type"
          value={type}
          onChange={setType}
          options={[
            { value: "ALL", label: "All" },
            { value: "LOST", label: "Lost" },
            { value: "FOUND", label: "Found" },
          ]}
        />
        <label className="relative block">
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title or description…"
            aria-label="Search posts"
            className="w-full rounded-full border border-outline-variant bg-surface pl-10 pr-4 py-3 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
          />
        </label>
      </div>

      <NewPostsPill count={newPostCount} hasUpdates={hasUpdates} onTap={onNewPostsTap} />

      <PullToRefresh ref={scrollRef} onRefresh={refresh} disabled={loading} className="flex-1">
        <PostList
          items={items}
          loading={loading}
          loadingMore={loadingMore}
          error={error}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onRetry={refresh}
          emptyTitle={appliedQuery ? "No matches" : "Nothing here yet"}
          emptySubtitle={
            appliedQuery
              ? `No posts match “${appliedQuery}”.`
              : "Tap Report below to post a lost or found item."
          }
        />
      </PullToRefresh>
    </div>
  );
}