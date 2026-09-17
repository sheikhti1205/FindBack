import { useEffect, useRef } from "react";
import { PostList } from "../components/PostList";
import { PullToRefresh, type PullToRefreshHandle } from "../components/PullToRefresh";
import { useFeed } from "../hooks/useFeed";
import { useTabTap } from "../components/TabTap";
import { useAuth } from "../auth";

const MY_CACHE_BASE = "my:reports";

export function MyPosts() {
  const { user } = useAuth();
  const { tapCount } = useTabTap();
  const scrollRef = useRef<PullToRefreshHandle>(null);
  const myCacheKey = user?.id ? `${MY_CACHE_BASE}:${user.id}` : MY_CACHE_BASE;

  const { items, total, loading, loadingMore, error, hasMore, refresh, loadMore } = useFeed(
    { userId: user?.id },
    { cacheKey: myCacheKey, scrollRef },
  );

  // Active Profile tab tap does not reach here (My Reports is a sub-screen),
  // but keep the same refresh+top behavior for consistency.
  useEffect(() => {
    if (tapCount === 0) return;
    void refresh();
    scrollRef.current?.scrollToTop();
  }, [tapCount]);

  return (
    <div className="flex h-full flex-col gap-4 py-5">
      <header className="px-4">
        <h1 className="text-xl font-semibold tracking-tight">My reports</h1>
        <p className="text-sm text-on-surface-variant">
          {total} report{total === 1 ? "" : "s"} · manage the status of items you have reported.
        </p>
      </header>

      <PullToRefresh ref={scrollRef} onRefresh={refresh} disabled={loading} className="flex-1">
        <PostList
          items={items}
          loading={loading}
          loadingMore={loadingMore}
          error={error}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onRetry={refresh}
          emptyTitle="You have no reports yet"
          emptySubtitle="Tap Report to post a lost or found item."
        />
      </PullToRefresh>
    </div>
  );
}