import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, X } from "lucide-react";
import { Link } from "react-router";
import type { PostType } from "@findback/shared";
import { Segmented } from "../components/Segmented";
import { PostList } from "../components/PostList";
import { useFeed } from "../hooks/useFeed";
import { useUrlParam } from "../hooks/useUrlParam";
import { useTabTap } from "../components/TabTap";
import { AdvancedSearchFilters, useAdvancedSearchFilters } from "./AdvancedSearchFilters";
import type { NlFilterPatch } from "../services/search/nlFilters";
import { nlExtractLive, nlHelperState } from "../services/liveNarrowTasks";
import { OFFLINE_NEEDS_ANDROID } from "./AiModels";
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

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Smart Search's not-set-up sentence (CF-040 F6). It names the one action that
 * fixes the state, because the sentence is a live region and the "Manage AI
 * models" affordance beside it is a sibling — a screen-reader user is told what
 * happened and what to do, without the interactive element inside the region.
 */
const NL_HELPER_NOT_SET_UP_NOTE =
  "Smart Search needs the on-device model, which isn't set up on this device yet — open Manage AI models to install it.";

export function SearchScreen(props: {
  /** Injected NL extractor (test fakes or a live extractNlFilters composer).
   * Absent means the live transport. Explicit undefined keeps smart search
   * unavailable: the button stays disabled and nothing is ever guessed. */
  nlExtract?: (input: string) => Promise<NlFilterPatch>;
}) {
  // Default-on live transport: a bare mount (App.tsx) gets nlExtractLive.
  // An explicit prop — including explicit undefined — always wins so tests
  // can inject fakes or pin the disabled copy.
  const nlExtract = "nlExtract" in props ? props.nlExtract : nlExtractLive;
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
  // NL-derived date bounds. Only well-formed ISO days reach the feed; a
  // crafted deep-link value never becomes a filter.
  const [dateFromParam, setDateFromParam] = useUrlParam("dateFrom");
  const [dateToParam, setDateToParam] = useUrlParam("dateTo");
  const dateFrom = ISO_DATE_PATTERN.test(dateFromParam) ? dateFromParam : "";
  const dateTo = ISO_DATE_PATTERN.test(dateToParam) ? dateToParam : "";
  // NL smart search: extracted values land in the ordinary editable
  // controls above (query field, filter chips), never applied blindly.
  const [nlInput, setNlInput] = useState("");
  const [nlBusy, setNlBusy] = useState(false);
  const [nlNote, setNlNote] = useState<string | null>(null);
  // True only when an empty result means "the helper isn't set up here", not
  // "the helper looked and found nothing". Those two are different truths and
  // must not share copy (CF-040 F6).
  const [nlHelperMissing, setNlHelperMissing] = useState(false);

  async function applyNlFilters() {
    const text = nlInput.trim();
    if (nlExtract === undefined || nlBusy || text === "") return;
    setNlBusy(true);
    setNlNote(null);
    setNlHelperMissing(false);
    try {
      const patch = await nlExtract(text);
      let applied = 0;
      if (patch.query !== undefined) {
        setQuery(patch.query);
        applied += 1;
      }
      if (patch.category !== undefined) {
        advanced.setCategory(patch.category);
        applied += 1;
      }
      if (patch.status !== undefined) {
        advanced.setStatus(patch.status);
        applied += 1;
      }
      if (patch.dateFrom !== undefined) {
        setDateFromParam(patch.dateFrom);
        applied += 1;
      }
      if (patch.dateTo !== undefined) {
        setDateToParam(patch.dateTo);
        applied += 1;
      }
      // An empty patch has three very different causes: the helper ran and
      // wasn't confident, the helper isn't on this device at all, or the engine
      // failed after the helper was found (`extractNlFilters` collapses an op
      // failure to `{}`, so a busy runtime still reads as the first — recorded
      // as the F6 residual in the work queue). Because the third is known and
      // accepted, "no confident filters" must still be the default; but the
      // second is a lie about why nothing happened, so ask the device first and
      // offer the one action that fixes it (CF-040 F6). On a build that cannot
      // run on-device AI at all, the canonical Android-required line replaces
      // the install offer, because no install will ever change it.
      const helperState = await nlHelperState();
      setNlHelperMissing(applied === 0 && helperState === "not-set-up");
      setNlNote(
        applied === 0
          ? helperState === "unsupported-platform"
            ? OFFLINE_NEEDS_ANDROID
            : helperState === "not-set-up"
              ? NL_HELPER_NOT_SET_UP_NOTE
              : "No confident filters found — nothing changed."
          : `Applied ${applied} smart filter${applied === 1 ? "" : "s"} — review or remove them below.`,
      );
    } catch {
      setNlNote("Smart search failed — nothing changed.");
    } finally {
      setNlBusy(false);
    }
  }
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

  const { items, total, loading, loadingMore, error, hasMore, refresh, loadMore } = useFeed(
    {
      type: type === "ALL" ? "" : type,
      category: advanced.category || undefined,
      status: advanced.status || undefined,
      sort: advanced.sort,
      q: appliedQuery || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
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
                className="shrink-0 rounded-full min-h-[48px] px-2 text-sm font-medium text-on-surface"
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

        <div className="flex items-center gap-2">
          <label htmlFor="nl-search" className="sr-only">
            Describe your search
          </label>
          <input
            id="nl-search"
            type="text"
            value={nlInput}
            onChange={(e) => setNlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void applyNlFilters();
            }}
            placeholder="Try &lsquo;black wallet lost last week&rsquo;&hellip;"
            aria-label="Describe your search"
            className="min-w-0 flex-1 rounded-m3-sm border border-outline-variant bg-surface px-3 py-3 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void applyNlFilters()}
            disabled={nlExtract === undefined || nlBusy || nlInput.trim() === ""}
            title={nlExtract === undefined ? "Smart search unavailable" : "Apply smart filters"}
            className="inline-flex min-h-[48px] shrink-0 items-center justify-center rounded-m3-sm border border-outline-variant bg-surface px-4 text-sm font-medium text-on-surface disabled:opacity-50"
          >
            {nlBusy ? "Applying…" : "Smart search"}
          </button>
        </div>
        {nlNote !== null && (
          <div className="flex flex-wrap items-center gap-2" data-testid="smart-search-note-row">
            <p className="text-xs text-on-surface-variant" role="status">
              {nlNote}
            </p>
            {nlHelperMissing && (
              <Link
                to="/settings/ai/models"
                data-testid="smart-search-manage-models"
                className="inline-flex min-h-[48px] items-center rounded-full border border-outline-variant px-4 text-sm font-medium text-on-surface transition-colors hover:bg-surface-container"
              >
                Manage AI models
              </Link>
            )}
          </div>
        )}

        <AdvancedSearchFilters filters={advanced} />
        {(dateFrom !== "" || dateTo !== "") && (
          <div className="flex flex-wrap items-center gap-2" aria-label="Date filters">
            {dateFrom !== "" && (
              <button
                type="button"
                onClick={() => setDateFromParam("")}
                aria-label="Remove start date filter"
                className="inline-flex min-h-[48px] items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container px-3 text-sm text-on-surface"
              >
                From {dateFrom}<X size={14} aria-hidden />
              </button>
            )}
            {dateTo !== "" && (
              <button
                type="button"
                onClick={() => setDateToParam("")}
                aria-label="Remove end date filter"
                className="inline-flex min-h-[48px] items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container px-3 text-sm text-on-surface"
              >
                To {dateTo}<X size={14} aria-hidden />
              </button>
            )}
          </div>
        )}
      </section>

      <div ref={scrollRef} onScroll={handleResultsScroll} className="flex-1 overflow-y-auto">
        <PostList
          items={items}
          loading={loading}
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
