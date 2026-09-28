import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, X } from "lucide-react";
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
import { AdvancedSearchFilters, FiltersIconButton, getActiveFilterCount, useAdvancedSearchFilters } from "./AdvancedSearchFilters";
import type { FeedFilters } from "../services/posts";
import {
  fadeVariants,
  motionDurations,
  motionEasings,
  motionSprings,
  pressFeedback,
  scaleInVariants,
  shouldReduceMotion,
} from "../components/uiMotion";

type TypeFilter = PostType | "ALL";

const HOME_CACHE_KEY = "home:feed";

export function Home() {
  const { user } = useAuth();
  const { tapCount } = useTabTap();
  // Imperative travel (scroll-to-top) cannot see MotionConfig — collapse to
  // instant when the OS prefers reduced motion. Read live (not the cached
  // framer-motion singleton) so the value is exact at render/scroll time.
  const reduceMotion = shouldReduceMotion();
  // Type + search survive in the URL so back-nav, deep-links, and copied
  // links restore the feed the reader was looking at.
  const [typeParam, setTypeParam] = useUrlParam("type");
  const type: TypeFilter = typeParam === "LOST" || typeParam === "FOUND" ? typeParam : "ALL";
  const setType = (next: TypeFilter) => setTypeParam(next === "ALL" ? "" : next);
  const [qParam, setQParam] = useUrlParam("q");
  const [query, setQuery] = useState(qParam);
  const [appliedQuery, setAppliedQuery] = useState(qParam.trim());
  // Search activation: the field rests as a compact affordance and expands
  // into its active state on focus/input; clear/cancel collapse it back.
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchActive = searchFocused || query.length > 0;
  // Toolbar separation: a subtle border/shadow once the feed scrolls.
  const [toolbarSeparated, setToolbarSeparated] = useState(false);
  const toolbarSeparatedRef = useRef(false);
  const advanced = useAdvancedSearchFilters();
  const feedFilters: FeedFilters = {
    type: type === "ALL" ? "" : type,
    q: appliedQuery || undefined,
    category: advanced.category || undefined,
    status: advanced.status || undefined,
    sort: advanced.sort,
  };
  const scopedCacheKey = buildFeedCacheKey(HOME_CACHE_KEY, feedFilters);
  const [newPostCount, setNewPostCount] = useState(() => getNewPostCount(scopedCacheKey));
  const [hasUpdates, setHasUpdates] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
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

  const { items, total, loading, refreshing, loadingMore, error, hasMore, refresh, loadMore, removeItem } = useFeed(
    feedFilters,
    { cacheKey: HOME_CACHE_KEY, scrollRef },
  );

  // Active Home tab tap: refresh + scroll top. Smooth normally, instant
  // under reduced motion. Scroll restore after Post Detail comes from the
  // useFeed session cache (items + scrollTop survive unmount); mounting here
  // never replays card entrances — no list animation is owned by this file.
  useEffect(() => {
    if (tapCount === 0) return;
    void refresh();
    scrollRef.current?.scrollToTop(reduceMotion ? "auto" : "smooth");
    setNewPostCount(0);
    setHasUpdates(false);
    clearNewPostCount(scopedCacheKey);
  }, [tapCount, refresh, scopedCacheKey, reduceMotion]);

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

      const matchesFilter = typeOk && !appliedQuery && !advanced.category && !advanced.status;
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
  }, [refresh, scopedCacheKey, type, appliedQuery, advanced.category, advanced.status]);

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
    scrollRef.current?.scrollToTop(reduceMotion ? "auto" : "smooth");
    setNewPostCount(0);
    setHasUpdates(false);
    clearNewPostCount(scopedCacheKey);
  }

  // Scroll events from the PullToRefresh container do not bubble, but React
  // listens in the capture phase — one guarded setState per crossing, never
  // per pixel, so the toolbar toggle cannot rerender the feed on scroll.
  function handleFeedScroll(e: SyntheticEvent) {
    const top = (e.target as HTMLElement).scrollTop ?? 0;
    const next = top > 8;
    if (next !== toolbarSeparatedRef.current) {
      toolbarSeparatedRef.current = next;
      setToolbarSeparated(next);
    }
  }

  function collapseSearch() {
    setQuery("");
    setSearchFocused(false);
    searchInputRef.current?.blur();
  }

  return (
    <div className="flex h-full flex-col gap-4" onScrollCapture={handleFeedScroll}>
      <header
        data-testid="home-toolbar"
        style={{ transitionDuration: reduceMotion ? "0s" : `${motionDurations.fast}s` }}
        className={`border-b px-4 pt-5 transition-[border-color,box-shadow] ${
          toolbarSeparated ? "border-outline-variant shadow-sm" : "border-transparent shadow-none"
        }`}
      >
        <h1 className="text-xl font-semibold tracking-tight">FindBack</h1>
        <AnimatePresence initial={false} mode="wait">
          <motion.p
            key={total}
            variants={fadeVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
            className="text-xs text-on-surface-variant"
          >
            {total} item{total === 1 ? "" : "s"} · signed in as @{user?.username}
          </motion.p>
        </AnimatePresence>
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
        <div className="flex items-center gap-2">
          <motion.div
            layout
            transition={motionSprings.soft}
            className="flex min-w-0 flex-1 items-center rounded-full border border-outline-variant bg-surface pl-1 pr-4 focus-within:border-on-surface"
          >
            <FiltersIconButton
              activeCount={getActiveFilterCount(advanced)}
              open={filtersOpen}
              onClick={() => setFiltersOpen(true)}
            />
            <Search
              size={16}
              aria-hidden
              className="pointer-events-none ml-1 shrink-0 text-on-surface-variant"
            />
            <input
              ref={searchInputRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder="Search title or description…"
              aria-label="Search posts"
              className="min-w-0 flex-1 bg-transparent py-3 pl-2 text-sm placeholder:text-on-surface-variant focus:outline-none"
            />
            <AnimatePresence initial={false}>
              {query.length > 0 && (
                <motion.button
                  key="home-search-clear"
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  whileTap={pressFeedback.iconButton}
                  variants={scaleInVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
                  className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-full text-on-surface-variant"
                >
                  <X size={16} aria-hidden />
                </motion.button>
              )}
            </AnimatePresence>
          </motion.div>
          <AnimatePresence initial={false}>
            {searchActive && (
              <motion.button
                key="home-search-cancel"
                type="button"
                onClick={collapseSearch}
                variants={fadeVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
                className="shrink-0 rounded-full px-2 text-sm font-medium text-on-surface"
              >
                Cancel
              </motion.button>
            )}
          </AnimatePresence>
        </div>
        <AdvancedSearchFilters
          filters={advanced}
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
          hideTrigger
        />
      </div>

      <NewPostsPill count={newPostCount} hasUpdates={hasUpdates} onTap={onNewPostsTap} />

      <PullToRefresh ref={scrollRef} onRefresh={refresh} disabled={loading || refreshing} className="flex-1">
        <PostList
          items={items}
          loading={loading}
          refreshing={refreshing}
          loadingMore={loadingMore}
          error={error}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onRetry={refresh}
          density="editorial"
          emptyTitle={appliedQuery || advanced.category || advanced.status ? "No matches" : "Nothing here yet"}
          emptySubtitle={
            advanced.category || advanced.status
              ? "Try different filters or a broader search."
              : appliedQuery
                ? `No posts match “${appliedQuery}”.`
                : "Tap Create report to post a lost or found item."
          }
        />
      </PullToRefresh>
    </div>
  );
}
