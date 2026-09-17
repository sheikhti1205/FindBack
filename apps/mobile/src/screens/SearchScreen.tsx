import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { Category, PostStatus, PostType } from "@findback/shared";
import { Segmented, STATUS_OPTIONS } from "../components/Segmented";
import { SelectField } from "../components/Fields";
import { PostList } from "../components/PostList";
import { CategoryField } from "../components/CategoryField";
import { useFeed } from "../hooks/useFeed";
import { useTabTap } from "../components/TabTap";

type TypeFilter = PostType | "ALL";

export function SearchScreen() {
  const { tapCount } = useTabTap();
  const [type, setType] = useState<TypeFilter>("ALL");
  const [category, setCategory] = useState<Category | "">("");
  const [status, setStatus] = useState<PostStatus | "">("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Debounce search input ~400ms — do not network-fetch every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setAppliedQuery(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);

  const { items, total, loading, loadingMore, error, hasMore, refresh, loadMore } = useFeed({
    type: type === "ALL" ? "" : type,
    category: category || undefined,
    status: status || undefined,
    sort,
    q: appliedQuery || undefined,
  });

  // Active Search tab tap: rerun current filters + scroll top, preserve filters.
  useEffect(() => {
    if (tapCount === 0) return;
    void refresh();
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [tapCount]);

  return (
    <div className="flex h-full flex-col gap-4">
      <header className="px-4 pt-5">
        <h1 className="text-xl font-semibold tracking-tight">Search &amp; filter</h1>
        <p className="text-xs text-on-surface-variant">{total} results</p>
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
            className="w-full rounded-m3-sm border border-outline-variant bg-surface py-3 pl-10 pr-4 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <CategoryField value={category} onChange={setCategory} />
          <SelectField
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as PostStatus | "")}
            options={STATUS_OPTIONS}
          />
        </div>
        <SelectField
          label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as "newest" | "oldest")}
          options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
          ]}
        />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <PostList
          items={items}
          loading={loading}
          loadingMore={loadingMore}
          error={error}
          hasMore={hasMore}
          onLoadMore={loadMore}
          emptyTitle="No matches"
          emptySubtitle="Try different filters or a broader search."
        />
      </div>
    </div>
  );
}