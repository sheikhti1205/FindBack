import { useEffect, useRef } from "react";
import type { PostItem } from "@findback/shared";
import { FileQuestion } from "lucide-react";
import { PostCard } from "./PostCard";
import { PostCardContent, type PostCardLayout } from "./PostCardContent";
import { EmptyState, Spinner } from "./PostCard";

interface PostListProps {
  items: PostItem[];
  loading: boolean;
  refreshing?: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  onRetry?: () => Promise<void>;
  emptyTitle?: string;
  emptySubtitle?: string;
  /** U2 hybrid rollout: `editorial` (Home Variant A, airy photo-led cards) or
   *  `compact` (Search Variant B, dense rows). Omitted = pre-U2 rendering. */
  density?: "editorial" | "compact";
}

export function PostList({
  items,
  loading,
  refreshing = false,
  loadingMore,
  error,
  hasMore,
  onLoadMore,
  onRetry,
  emptyTitle = "Nothing here yet",
  emptySubtitle = "Be the first to post a lost or found item.",
  density,
}: PostListProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Do not auto-paginate while an append error is showing: the user must
        // press Retry, otherwise the visible button races a background retry.
        if (entries[0]?.isIntersecting && hasMore && !loadingMore && !error) {
          void onLoadMore();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore, error]);

  if (loading && items.length === 0) return <Spinner label="Loading posts…" />;

  if (error && items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-8">
        <EmptyState icon={<FileQuestion size={28} />} title="Could not load" subtitle={error} />
        {onRetry && (
          <button
            type="button"
            onClick={() => void onRetry()}
            className="min-h-[48px] rounded-m3-sm border border-outline-variant px-4 text-sm font-medium"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  if (items.length === 0) {
    return <EmptyState icon={<FileQuestion size={28} />} title={emptyTitle} subtitle={emptySubtitle} />;
  }

  // U2: density maps to card layout; omitted density keeps pre-U2 rendering
  // so rollout-external screens (e.g. MyPosts) are pixel-identical.
  const layout: PostCardLayout = density === "compact" ? "compact" : density === "editorial" ? "editorial" : "classic";
  const listClass =
    density === "compact"
      ? "flex flex-col gap-2 px-3"
      : density === "editorial"
        ? "flex flex-col gap-4 px-4"
        : "flex flex-col gap-3 px-4";

  return (
    <div className={listClass}>
      {refreshing && items.length > 0 && (
        <p role="status" className="py-1 text-center text-xs text-on-surface-variant">
          Refreshing…
        </p>
      )}
      {error && (
        <div className="flex items-center justify-between gap-2 rounded-m3-sm border border-error px-3 py-2 text-sm text-error">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void onLoadMore()}
            className="min-h-[48px] shrink-0 px-3 font-medium underline"
          >
            Retry
          </button>
        </div>
      )}
      {items.map((post, i) => (
        <PostCard key={post.id} to={`/posts/${post.id}`} index={i}>
          <PostCardContent post={post} layout={layout} />
        </PostCard>
      ))}
      <div ref={sentinelRef} aria-hidden />
      {loadingMore && <Spinner label="Loading more…" />}
      {!hasMore && items.length > 0 && (
        <p className="py-3 text-center text-xs text-on-surface-variant">
          You are all caught up.
        </p>
      )}
    </div>
  );
}
