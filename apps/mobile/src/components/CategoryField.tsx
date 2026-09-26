import { useMemo, useState } from "react";
import type { Category } from "@findback/shared";
import { CATEGORY_GROUPS, isReleasedCategory, RELEASED_CATEGORIES, searchCategoryCatalog } from "@findback/shared";
import { Check, ChevronDown, Lock, Search, X } from "lucide-react";
import { BottomSheet } from "./BottomSheet";

/** Released canonical options only — safe to submit to the deployed validator. */
export const CATEGORY_OPTIONS = RELEASED_CATEGORIES.map((canonical) => ({
  value: canonical as Category,
  label: canonical,
}));

const UNRELEASED_HINT = "Coming after database update";

interface CategoryFieldProps {
  value: Category | "";
  onChange: (value: Category | "") => void;
  error?: string;
}

export function CategoryField({ value, onChange, error }: CategoryFieldProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const errorId = error ? "category-error" : undefined;

  const results = useMemo(() => searchCategoryCatalog(query), [query]);
  const grouped = useMemo(
    () =>
      CATEGORY_GROUPS.map((group) => ({
        group,
        options: results.filter((option) => option.group === group),
      })).filter((entry) => entry.options.length > 0),
    [results],
  );

  function commit(canonical: string) {
    if (!isReleasedCategory(canonical)) return;
    onChange(canonical as Category);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-on-surface">Category</span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Category"
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        data-testid="category-trigger"
        className={`flex min-h-[48px] w-full items-center justify-between gap-2 rounded-m3-sm border bg-surface px-3.5 py-3 text-left text-base ${
          error ? "border-error" : "border-outline-variant"
        }`}
      >
        <span className={value ? "text-on-surface" : "text-on-surface-variant"}>
          {value || "Choose a category"}
        </span>
        <ChevronDown aria-hidden="true" size={18} className="shrink-0 text-on-surface-variant" />
      </button>
      {error && (
        <p id={errorId} role="alert" className="text-sm text-error">
          {error}
        </p>
      )}

      <BottomSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Choose a category"
        description="Pick the group that best matches the item."
      >
        <div className="flex flex-col gap-3 pb-2">
          <div className="relative">
            <Search
              aria-hidden="true"
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search categories"
              aria-label="Search categories"
              className="min-h-[48px] w-full rounded-m3-sm border border-outline-variant bg-surface pl-9 pr-10 text-base"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear category search"
                className="absolute right-1 top-1/2 flex min-h-[48px] min-w-[48px] -translate-y-1/2 items-center justify-center"
              >
                <X aria-hidden="true" size={16} />
              </button>
            )}
          </div>

          {grouped.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <p className="text-sm text-on-surface">No categories match “{query}”.</p>
              <button
                type="button"
                onClick={() => setQuery("")}
                className="min-h-[48px] rounded-m3-sm border border-outline-variant px-4 text-sm"
              >
                Show all categories
              </button>
            </div>
          ) : (
            grouped.map(({ group, options }) => (
              <section key={group} className="flex flex-col gap-1">
                <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                  {group}
                </h3>
                {options.map((option) => {
                  const released = isReleasedCategory(option.canonical);
                  const selected = value === option.canonical;
                  return (
                    <button
                      key={option.canonical}
                      type="button"
                      disabled={!released}
                      aria-pressed={selected}
                      aria-label={option.canonical}
                      title={released ? option.examples : UNRELEASED_HINT}
                      onClick={() => commit(option.canonical)}
                      className={`flex min-h-[48px] w-full items-center justify-between gap-3 rounded-m3-xs px-3 py-2 text-left text-base ${
                        released ? "hover:bg-surface-container" : "opacity-50"
                      }`}
                    >
                      <span className="flex flex-col">
                        <span className="text-on-surface">{option.canonical}</span>
                        <span className="text-xs text-on-surface-variant">
                          {released ? option.examples : UNRELEASED_HINT}
                        </span>
                      </span>
                      {selected && <Check aria-hidden="true" size={18} className="shrink-0" />}
                      {!released && <Lock aria-hidden="true" size={16} className="shrink-0 text-on-surface-variant" />}
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </div>
      </BottomSheet>
    </div>
  );
}
