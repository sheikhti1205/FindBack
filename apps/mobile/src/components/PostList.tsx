import { useEffect, useRef } from "react";
import type { PostItem } from "@findback/shared";
import { FileQuestion } from "lucide-react";
import { PostCard } from "./PostCard";
import { PostCardContent } from "./PostCardContent";
import { EmptyState, Spinner } from "./PostCard";

interface PostListProps {
  items: PostItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  emptyTitle?: string;
  emptySubtitle?: string;
}

export function PostList({
  items,
  loading,
  loadingMore,
  error,
  hasMore,
  onLoadMore,
  emptyTitle = "Nothing here yet",
  emptySubtitle = "Be the first to post a lost or found item.",
}: PostListProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loadingMore) {
          void onLoadMore();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore]);

  if (loading && items.length === 0) return <Spinner label="Loading posts…" />;

  if (error && items.length === 0) {
    return <EmptyState icon={<FileQuestion size={28} />} title="Could not load" subtitle={error} />;
  }

  if (items.length === 0) {
    return <EmptyState icon={<FileQuestion size={28} />} title={emptyTitle} subtitle={emptySubtitle} />;
  }

  return (
    <div className="flex flex-col gap-3 px-4">
      {error && (
        <p className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error">{error}</p>
      )}
      {items.map((post, i) => (
        <PostCard key={post.id} to={`/posts/${post.id}`} index={i}>
          <PostCardContent post={post} />
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
