import { Fragment, useEffect, useRef } from "react";
import type { PostItem } from "@findback/shared";
import { AnimatePresence, motion } from "framer-motion";
import { FileQuestion } from "lucide-react";
import { PostCard } from "./PostCard";
import { OwnerReportCard } from "./OwnerReportCard";
import { PostCardContent, type PostCardLayout } from "./PostCardContent";
import { EmptyState, Spinner } from "./PostCard";
import { fadeVariants, listItemVariants, motionDurations, motionEasings } from "./uiMotion";

interface PostListProps {
  items: PostItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  onRetry?: () => Promise<void>;
  emptyTitle?: string;
  emptySubtitle?: string;
  /** U2 hybrid rollout: `editorial` (Home Variant A, airy photo-led cards) or
   *  `compact` (Search Variant B, dense rows). `home-feed` is the
   *  reference-inspired Home redesign (image-left/content-right). `owner-feed`
   *  is the UXN-4 My Reports owner card (image-left, prominent status).
   *  Omitted = pre-U2 rendering. */
  density?: "editorial" | "compact" | "home-feed" | "owner-feed";
}

export function PostList({
  items,
  loading,
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

  // Density maps to card layout; omitted density keeps pre-U2 rendering.
  // `home-feed` is Home-only; Search stays `compact`, classic stays classic.
  // UXN-4 append-only: `owner-feed` renders compact OwnerReportCards via its
  // own component and never alters the mappings below.
  const isOwnerFeed = density === "owner-feed";
  const layout: PostCardLayout =
    density === "compact" ? "compact" : density === "home-feed" ? "home-feed" : density === "editorial" ? "editorial" : "classic";
  const listClass =
    density === "compact"
      ? "flex flex-col gap-2 px-3"
      : density === "home-feed"
        ? "flex flex-col gap-3 px-4"
        : density === "editorial"
          ? "flex flex-col gap-4 px-4"
          : "flex flex-col gap-3 px-4";

  // Wave A: short opacity-only swaps between feed states. The spinner exits
  // as content enters (and likewise for error/empty), so loading → results
  // never pops. AnimatePresence initial={false} keeps the first paint
  // instant; later state changes crossfade within the fast token budget.
  // Opacity is preserved under reduced motion by the root MotionConfig.
  const stateTransition = { duration: motionDurations.fast, ease: motionEasings.inOut };
  const state = loading && items.length === 0 ? "loading" : error && items.length === 0 ? "error" : items.length === 0 ? "empty" : "content";

  // Refresh reconcile (C4): rows the reader has already seen stay exactly
  // in place; rows that arrive after the first paint (a refresh that found
  // new/changed reports) enter with one short subtle fade/position step on
  // the fast token. First paint is the baseline, so initial load never
  // cascades. Reduced motion collapses the rise centrally (root
  // MotionConfig); the opacity acknowledgement is preserved by policy.
  const seenIdsRef = useRef<Set<string> | null>(null);
  if (seenIdsRef.current === null) {
    seenIdsRef.current = new Set(items.map((post) => post.id));
  }
  useEffect(() => {
    const seen = seenIdsRef.current!;
    for (const post of items) seen.add(post.id);
  }, [items]);

  return (
    <AnimatePresence initial={false}>
      {state === "loading" && (
        <motion.div
          key="loading"
          variants={fadeVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={stateTransition}
        >
          <Spinner label="Loading posts…" />
        </motion.div>
      )}
      {state === "error" && (
        <motion.div
          key="error"
          variants={fadeVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={stateTransition}
        >
          <div className="flex flex-col items-center gap-3 px-4 py-8">
            <EmptyState icon={<FileQuestion size={28} />} title="Could not load" subtitle={error ?? ""} />
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
        </motion.div>
      )}
      {state === "empty" && (
        <motion.div
          key="empty"
          variants={fadeVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={stateTransition}
        >
          <EmptyState icon={<FileQuestion size={28} />} title={emptyTitle} subtitle={emptySubtitle} />
        </motion.div>
      )}
      {state === "content" && (
        <motion.div
          key="content"
          variants={fadeVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={stateTransition}
        >
          <div className={listClass}>
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
            {items.map((post, i) => {
              const card = isOwnerFeed ? (
                <OwnerReportCard post={post} />
              ) : (
                <PostCard
                  to={`/posts/${post.id}`}
                  index={i}
                  variant={layout === "home-feed" ? "home-feed" : "default"}
                >
                  <PostCardContent post={post} layout={layout} enableSharedMedia />
                </PostCard>
              );
              // Already-seen rows render untouched (no remount, no flash).
              if (seenIdsRef.current!.has(post.id)) {
                return <Fragment key={post.id}>{card}</Fragment>;
              }
              return (
                <motion.div
                  key={post.id}
                  data-reconcile="enter"
                  variants={listItemVariants}
                  initial="hidden"
                  animate="visible"
                  transition={stateTransition}
                >
                  {card}
                </motion.div>
              );
            })}
            <div ref={sentinelRef} aria-hidden />
            {loadingMore && <Spinner label="Loading more…" />}
            {!hasMore && items.length > 0 && (
              <p className="py-3 text-center text-xs text-on-surface-variant">
                You are all caught up.
              </p>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
