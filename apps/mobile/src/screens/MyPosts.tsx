import { useEffect, useRef, useState } from "react";
import type { PostStatus } from "@findback/shared";
import { BackButton } from "../components/BackButton";
import { PostList } from "../components/PostList";
import { PullToRefresh, type PullToRefreshHandle } from "../components/PullToRefresh";
import { useFeed } from "../hooks/useFeed";
import { useTabTap } from "../components/TabTap";
import { useAuth } from "../auth";

const MY_CACHE_BASE = "my:reports";

/** UXN-4 owner-status quick filters. ALL clears the status restriction;
 *  every option keeps the userId feed restriction. */
export type OwnerStatusFilter = "ALL" | PostStatus;

const OWNER_STATUS_OPTIONS: { value: OwnerStatusFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "OPEN", label: "Open" },
  { value: "MATCHED", label: "Matched" },
  { value: "RECOVERED", label: "Recovered" },
  { value: "CLOSED", label: "Closed" },
];

export function MyPosts() {
  const { user } = useAuth();
  const { tapCount } = useTabTap();
  const scrollRef = useRef<PullToRefreshHandle>(null);
  const [ownerStatus, setOwnerStatus] = useState<OwnerStatusFilter>("ALL");
  const filterRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // The feed filter carries userId, so the resolved cache key is already
  // user-scoped: `my:reports:<filterKey>`. Passing the base (not a
  // pre-scoped key) keeps it identical to the hook's own key.
  const { items, total, loading, refreshing, loadingMore, error, hasMore, refresh, loadMore } = useFeed(
    { userId: user?.id, status: ownerStatus === "ALL" ? "" : ownerStatus },
    { cacheKey: MY_CACHE_BASE, scrollRef },
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
      <header className="flex items-center gap-2 px-4">
        <BackButton fallbackTo="/profile" label="Back to profile" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">My reports</h1>
          <p className="text-sm text-on-surface-variant">
            {total} report{total === 1 ? "" : "s"} · manage the status of items you have reported.
          </p>
        </div>
      </header>

      <div className="fb-scroll-fade mx-4">
        <div
          role="radiogroup"
          aria-label="Filter by status"
          className="fb-scroll-row flex gap-2"
          onKeyDown={(event) => {
            const index = filterRefs.current.findIndex((button) => button === document.activeElement);
            if (index < 0) return;
            const next = event.key === "Home" ? 0 : event.key === "End" ? OWNER_STATUS_OPTIONS.length - 1
              : event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % OWNER_STATUS_OPTIONS.length
                : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + OWNER_STATUS_OPTIONS.length - 1) % OWNER_STATUS_OPTIONS.length : null;
            if (next == null) return;
            event.preventDefault();
            filterRefs.current[next]?.focus();
            setOwnerStatus(OWNER_STATUS_OPTIONS[next]!.value);
          }}
        >
          {OWNER_STATUS_OPTIONS.map((o, index) => {
            const selected = o.value === ownerStatus;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                ref={(element) => { filterRefs.current[index] = element; }}
                onClick={() => setOwnerStatus(o.value)}
                className={`min-h-[44px] shrink-0 rounded-full border px-4 text-sm font-medium transition-colors ${
                  selected
                    ? "border-transparent bg-on-surface text-surface"
                    : "border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container"
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      <PullToRefresh ref={scrollRef} onRefresh={refresh} disabled={loading || refreshing} className="flex-1">
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
          density="owner-feed"
        />
      </PullToRefresh>
    </div>
  );
}
