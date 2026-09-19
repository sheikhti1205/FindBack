import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { PostType } from "@findback/shared";
import { Segmented } from "../components/Segmented";
import { PostList } from "../components/PostList";
import { PullToRefresh, type PullToRefreshHandle } from "../components/PullToRefresh";
import { NewPostsPill } from "../components/NewPostsPill";
import { useFeed } from "../hooks/useFeed";
import { useUrlParam } from "../hooks/useUrlParam";
import { onRealtime } from "../services/realtime";
import { useAuth } from "../auth";
import { useTabTap } from "../components/TabTap";
import { buildFeedCacheKey, clearNewPostCount, getNewPostCount, incrementNewPostCount } from "../hooks/feedCache";

type TypeFilter = PostType | "ALL";

const HOME_CACHE_KEY = "home:feed";

export function Home() {
  const { user } = useAuth();
  const { tapCount } = useTabTap();
  // Type + search survive in the URL so back-nav, deep-links, and copied
  // links restore the feed the reader was looking at (WP7 #7).
  const [typeParam, setTypeParam] = useUrlParam("type");
  const type: TypeFilter = typeParam === "LOST" || typeParam === "FOUND" ? typeParam : "ALL";
  const setType = (next: TypeFilter) => setTypeParam(next === "ALL" ? "" : next);
  const [qParam, setQParam] = useUrlParam("q");
  const [query, setQuery] = useState(qParam);
  const [appliedQuery, setAppliedQuery] = useState(qParam.trim());
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

  // Publish the applied query to the URL once it settles.
  useEffect(() => {
    setQParam(appliedQuery);
  }, [appliedQuery, setQParam]);

  const { items, total, loading, loadingMore, error, hasMore, refresh, loadMore, removeItem } = useFeed(
    feedFilters,
    { cacheKey: HOME_CACHE_KEY, scrollRef },
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
      const change =
        typeof p.change === "string"
          ? p.change.toUpperCase()
          : typeof p.op === "string"
            ? p.op.toUpperCase()
            : typeof p.type === "string"
              ? p.type.toUpperCase()
              : null;
      // Only a genuine INSERT is a new post. Comment/reaction/rating triggers
      // broadcast feed:changed with a non-INSERT change kind.
      const isInsert = change === "INSERT" || p.isNew === true;
      const scrolled = (scrollRef.current?.scrollTop ?? 0) > 40;
      if (!isInsert) {
        if (!scrolled) void refresh();
        else setHasUpdates(true);
        return;
      }

      // Prove filter membership from the broadcast metadata. A provable
      // non-member (e.g. FOUND while filtered to LOST) is ignored — it can
      // never appear in this view, so it must not raise a pill. When an active
      // search query makes membership unprovable, show generic Updates.
      const postType = typeof p.postType === "string" ? p.postType.toUpperCase() : null;
      const typeOk = type === "ALL" || postType === type;
      const canProveNonMember = postType !== null && !typeOk;
      if (canProveNonMember) return;

      const matchesFilter = typeOk && !appliedQuery;
      if (scrolled) {
        if (matchesFilter) {
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
  }, [refresh, scopedCacheKey, type, appliedQuery]);

  // A post was deleted: reconcile it in place. Never refetch here — a full
  // refresh would rerender/reorder the list underneath a scrolled reader.
  useEffect(() => {
    const off = onRealtime("post:deleted", (payload) => {
      const postId = (payload as { postId?: unknown })?.postId;
      if (typeof postId === "string") removeItem(postId);
    });
    return off;
  }, [removeItem]);

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