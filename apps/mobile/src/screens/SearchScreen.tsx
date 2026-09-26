import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { CATEGORIES, POST_STATUSES, type Category, type PostStatus, type PostType } from "@findback/shared";
import { Segmented, STATUS_OPTIONS, statusLabel } from "../components/Segmented";
import { SelectField } from "../components/Fields";
import { BottomSheet } from "../components/BottomSheet";
import { PostList } from "../components/PostList";
import { CategoryField } from "../components/CategoryField";
import { useFeed } from "../hooks/useFeed";
import { useUrlParam } from "../hooks/useUrlParam";
import { useTabTap } from "../components/TabTap";

type TypeFilter = PostType | "ALL";

export function SearchScreen() {
  const { tapCount } = useTabTap();
  // Every filter survives in the URL so back-nav, deep-links, and copied
  // links restore the exact search the reader was looking at.
  const [typeParam, setTypeParam] = useUrlParam("type");
  const type: TypeFilter = typeParam === "LOST" || typeParam === "FOUND" ? typeParam : "ALL";
  const setType = (next: TypeFilter) => setTypeParam(next === "ALL" ? "" : next);
  const [categoryParam, setCategory] = useUrlParam("category");
  // Unknown deep-linked values degrade to empty rather than hitting the API.
  const category = (CATEGORIES as readonly string[]).includes(categoryParam)
    ? (categoryParam as Category)
    : "";
  const [statusParam, setStatus] = useUrlParam("status");
  const status = (POST_STATUSES as readonly string[]).includes(statusParam)
    ? (statusParam as PostStatus)
    : "";
  const [sortParam, setSortParam] = useUrlParam("sort");
  const sort: "newest" | "oldest" = sortParam === "oldest" ? "oldest" : "newest";
  const setSort = (next: "newest" | "oldest") => setSortParam(next === "newest" ? "" : next);
  const [qParam, setQParam] = useUrlParam("q");
  const [query, setQuery] = useState(qParam);
  const [appliedQuery, setAppliedQuery] = useState(qParam.trim());
  const [sheetOpen, setSheetOpen] = useState(false);
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
      category: category || undefined,
      status: status || undefined,
      sort,
      q: appliedQuery || undefined,
    },
    { cacheKey: "search:feed", scrollRef },
  );

  // Active Search tab tap: rerun current filters + scroll top, preserve filters.
  useEffect(() => {
    if (tapCount === 0) return;
    void refresh();
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scrollRef.current?.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }, [tapCount]);

  // Advanced filters (category/status/sort) live in the sheet; the visible row
  // keeps query + type only. Chips mirror the URL params exactly, so
  // back-nav, deep-links, and copied links restore the same search.
  const advancedFilters = [
    category
      ? { key: "category", label: `Category: ${category}`, clear: () => setCategory("") }
      : null,
    status
      ? { key: "status", label: `Status: ${statusLabel(status)}`, clear: () => setStatus("") }
      : null,
    sort !== "newest"
      ? {
          key: "sort",
          label: `Sort: ${sort === "oldest" ? "Oldest first" : "Newest first"}`,
          clear: () => setSort("newest"),
        }
      : null,
  ].filter((f): f is { key: string; label: string; clear: () => void } => f !== null);

  // Batched clear: three simultaneous useUrlParam writes issue three
  // replace navigations off the same stale location and only the last wins.
  // The hook states update immediately (chips vanish); this effect is
  // declared after the hooks, so it runs after their effects and its single
  // delete-all navigation applies last and wins. Later hook effects no-op
  // (values already match the clean URL).
  const [, setParams] = useSearchParams();
  const [pendingClear, setPendingClear] = useState(false);
  function clearAdvancedFilters(): void {
    setCategory("");
    setStatus("");
    setSort("newest");
    setPendingClear(true);
  }
  useEffect(() => {
    if (!pendingClear) return;
    setPendingClear(false);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("category");
        next.delete("status");
        next.delete("sort");
        return next;
      },
      { replace: true },
    );
  }, [pendingClear, setParams]);

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

        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-m3-sm border border-outline-variant bg-surface px-4 text-sm font-medium text-on-surface"
        >
          <SlidersHorizontal size={16} aria-hidden />
          Filters{advancedFilters.length > 0 ? ` (${advancedFilters.length})` : ""}
        </button>
      </section>

      {advancedFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-3" aria-label="Active filters">
          {advancedFilters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={f.clear}
              aria-label={`Remove ${f.key} filter`}
              className="inline-flex min-h-[48px] items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container px-3 text-sm text-on-surface"
            >
              {f.label}
              <X size={14} aria-hidden />
            </button>
          ))}
          <button
            type="button"
            onClick={clearAdvancedFilters}
            className="inline-flex min-h-[48px] items-center rounded-full px-3 text-sm font-medium text-on-surface underline"
          >
            Clear all filters
          </button>
        </div>
      )}

      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Filters"
        description="Category, status and sort. Changes apply immediately."
        height="medium"
      >
        <div className="flex flex-col gap-3 pb-2">
          <CategoryField value={category} onChange={setCategory} />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as PostStatus | "")}
            options={STATUS_OPTIONS}
          />
          <SelectField
            label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as "newest" | "oldest")}
            options={[
              { value: "newest", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
            ]}
          />
          {advancedFilters.length > 0 && (
            <button
              type="button"
              onClick={clearAdvancedFilters}
              className="inline-flex min-h-[48px] items-center justify-center rounded-m3-sm border border-outline-variant px-4 text-sm font-medium"
            >
              Clear all filters
            </button>
          )}
        </div>
      </BottomSheet>

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