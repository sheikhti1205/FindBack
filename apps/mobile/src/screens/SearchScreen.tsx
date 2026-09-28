import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { PostType } from "@findback/shared";
import { Segmented } from "../components/Segmented";
import { PostList } from "../components/PostList";
import { useFeed } from "../hooks/useFeed";
import { useUrlParam } from "../hooks/useUrlParam";
import { useTabTap } from "../components/TabTap";
import { AdvancedSearchFilters, useAdvancedSearchFilters } from "./AdvancedSearchFilters";

type TypeFilter = PostType | "ALL";

export function SearchScreen() {
  const { tapCount } = useTabTap();
  // Every filter survives in the URL so back-nav, deep-links, and copied
  // links restore the exact search the reader was looking at.
  const [typeParam, setTypeParam] = useUrlParam("type");
  const type: TypeFilter = typeParam === "LOST" || typeParam === "FOUND" ? typeParam : "ALL";
  const setType = (next: TypeFilter) => setTypeParam(next === "ALL" ? "" : next);
  const advanced = useAdvancedSearchFilters();
  const [qParam, setQParam] = useUrlParam("q");
  const [query, setQuery] = useState(qParam);
  const [appliedQuery, setAppliedQuery] = useState(qParam.trim());
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
  // Motion policy: animations always play — no reduced-motion gate here.
  useEffect(() => {
    if (tapCount === 0) return;
    void refresh();
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [tapCount]);

  return (
    <div className="flex h-full flex-col gap-3">
      <header className="px-3 pt-4">
        <h1 className="text-lg font-semibold tracking-tight">Search &amp; filter</h1>
        <p className="text-xs text-on-surface-variant" role="status">
          {total} result{total === 1 ? "" : "s"}
        </p>
      </header>

      <section aria-label="Search filters" className="flex flex-col gap-2 px-3">
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
            className="w-full rounded-m3-sm border border-outline-variant bg-surface py-3 pl-10 pr-4 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
          />
        </label>

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

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
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