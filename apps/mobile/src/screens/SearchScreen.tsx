import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, X } from "lucide-react";
import type { PostType } from "@findback/shared";
import { Segmented } from "../components/Segmented";
import { PostList } from "../components/PostList";
import { useFeed } from "../hooks/useFeed";
import { useUrlParam } from "../hooks/useUrlParam";
import { useTabTap } from "../components/TabTap";
import { AdvancedSearchFilters, useAdvancedSearchFilters } from "./AdvancedSearchFilters";
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

export function SearchScreen() {
  const { tapCount } = useTabTap();
  // Imperative travel (scroll-to-top) cannot see MotionConfig — collapse to
  // instant when the OS prefers reduced motion. Read live (not the cached
  // framer-motion singleton) so the value is exact at render/scroll time.
  const reduceMotion = shouldReduceMotion();
  // Every filter survives in the URL so back-nav, deep-links, and copied
  // links restore the exact search the reader was looking at.
  const [typeParam, setTypeParam] = useUrlParam("type");
  const type: TypeFilter = typeParam === "LOST" || typeParam === "FOUND" ? typeParam : "ALL";
  const setType = (next: TypeFilter) => setTypeParam(next === "ALL" ? "" : next);
  const advanced = useAdvancedSearchFilters();
  const [qParam, setQParam] = useUrlParam("q");
  const [query, setQuery] = useState(qParam);
  const [appliedQuery, setAppliedQuery] = useState(qParam.trim());
  // Search activation: the field rests as a compact affordance and expands
  // into its active state on focus/input; clear/cancel collapse it back.
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchActive = searchFocused || query.length > 0;
  // Toolbar separation: a subtle border/shadow once results scroll.
  const [toolbarSeparated, setToolbarSeparated] = useState(false);
  const toolbarSeparatedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Debounce search input ~400ms — do not network-fetch every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setAppliedQuery(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);

  // Publish the applied query to the URL once it settles.
  useEffect(() => {
    setQParam(appliedQuery);
  }, [appliedQuery, setQParam]);

  const { items, total, loading, refreshing, loadingMore, error, hasMore, refresh, loadMore } = useFeed(
    {
      type: type === "ALL" ? "" : type,
      category: advanced.category || undefined,
      status: advanced.status || undefined,
      sort: advanced.sort,
      q: appliedQuery || undefined,
    },
    { cacheKey: "search:feed", scrollRef },
  );

  // Active Search tab tap: rerun current filters + scroll top, preserve filters.
  // Smooth normally, instant when the OS prefers reduced motion.
  useEffect(() => {
    if (tapCount === 0) return;
    void refresh();
    scrollRef.current?.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }, [tapCount, refresh, reduceMotion]);

  // One guarded setState per toolbar crossing, never per pixel, so scroll
  // cannot rerender the results list.
  function handleResultsScroll(e: SyntheticEvent) {
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
    <div className="flex h-full flex-col gap-3">
      <header
        data-testid="search-toolbar"
        style={{ transitionDuration: reduceMotion ? "0s" : `${motionDurations.fast}s` }}
        className={`border-b px-3 pt-4 transition-[border-color,box-shadow] ${
          toolbarSeparated ? "border-outline-variant shadow-sm" : "border-transparent shadow-none"
        }`}
      >
        <h1 className="text-lg font-semibold tracking-tight">Search &amp; filter</h1>
        <AnimatePresence initial={false} mode="wait">
          <motion.p
            key={total}
            variants={fadeVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
            className="text-xs text-on-surface-variant"
            role="status"
          >
            {total} result{total === 1 ? "" : "s"}
          </motion.p>
        </AnimatePresence>
      </header>

      <section aria-label="Search filters" className="flex flex-col gap-2 px-3">
        <div className="flex items-center gap-2">
          <motion.label
            layout
            transition={motionSprings.soft}
            className="relative block min-w-0 flex-1"
          >
            <Search
              size={16}
              aria-hidden
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant"
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
              className="w-full rounded-m3-sm border border-outline-variant bg-surface py-3 pl-10 pr-10 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
            />
            <AnimatePresence initial={false}>
              {query.length > 0 && (
                <motion.button
                  key="search-clear"
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  whileTap={pressFeedback.iconButton}
                  variants={scaleInVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
                  className="absolute right-1 top-1/2 flex min-h-[48px] min-w-[48px] -translate-y-1/2 items-center justify-center rounded-full text-on-surface-variant"
                >
                  <X size={16} aria-hidden />
                </motion.button>
              )}
            </AnimatePresence>
          </motion.label>
          <AnimatePresence initial={false}>
            {searchActive && (
              <motion.button
                key="search-cancel"
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

        <AdvancedSearchFilters filters={advanced} />
      </section>

      <div ref={scrollRef} onScroll={handleResultsScroll} className="flex-1 overflow-y-auto">
        <PostList
          items={items}
          loading={loading}
          refreshing={refreshing}
          loadingMore={loadingMore}
          error={error}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onRetry={refresh}
          density="compact"
          emptyTitle="No matches"
          emptySubtitle="Try different filters or a broader search."
        />
      </div>
    </div>
  );
}
