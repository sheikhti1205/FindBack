import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { PostType } from "@findback/shared";
import { Segmented } from "../components/Segmented";
import { PostList } from "../components/PostList";
import { useFeed } from "../hooks/useFeed";
import { onRealtime } from "../services/realtime";
import { useAuth } from "../auth";

type TypeFilter = PostType | "ALL";

export function Home() {
  const { user } = useAuth();
  const [type, setType] = useState<TypeFilter>("ALL");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");

  // Debounce the search box so each keystroke does not hit the API.
  useEffect(() => {
    const t = setTimeout(() => setAppliedQuery(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);

  const { items, total, loading, loadingMore, error, hasMore, refresh, loadMore } = useFeed({
    type: type === "ALL" ? "" : type,
    q: appliedQuery || undefined,
  });

  // Live: a new/changed post elsewhere refreshes this feed without reload.
  useEffect(() => {
    const off = onRealtime("feed:changed", () => {
      void refresh();
    });
    return off;
  }, [refresh]);

  return (
    <div className="flex flex-col gap-4">
      <header className="px-4 pt-5">
        <h1 className="text-xl font-semibold tracking-tight">FindBack</h1>
        <p className="text-xs text-on-surface-variant">
          {total} item{total === 1 ? "" : "s"} · signed in as @{user?.username}
        </p>
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
            className="w-full rounded-full border border-outline-variant bg-surface pl-10 pr-4 py-3 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
          />
        </label>
      </div>

      <PostList
        items={items}
        loading={loading}
        loadingMore={loadingMore}
        error={error}
        hasMore={hasMore}
        onLoadMore={loadMore}
        emptyTitle={appliedQuery ? "No matches" : "Nothing here yet"}
        emptySubtitle={
          appliedQuery
            ? `No posts match “${appliedQuery}”.`
            : "Tap Report below to post a lost or found item."
        }
      />
    </div>
  );
}
