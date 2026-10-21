import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, X } from "lucide-react";
import { useSearchParams } from "react-router";
import type { PostType } from "@findback/shared";
import { Segmented } from "../components/Segmented";
import { PostList } from "../components/PostList";
import { useFeed } from "../hooks/useFeed";
import { useUrlParam } from "../hooks/useUrlParam";
import { useTabTap } from "../components/TabTap";
import { AdvancedSearchFilters, useAdvancedSearchFilters } from "./AdvancedSearchFilters";
import type { NlFilterPatch } from "../services/search/nlFilters";
import { nlExtractLive, nlHelperState } from "../services/liveNarrowTasks";
import { NL_EMPTY_PATCH_NOTE, NL_SEARCH_FAILED_NOTE, NL_SEARCH_FILTERS_CHANGED_NOTE, NL_SEARCH_INVALID_DATE_NOTE, nlSearchAppliedNote } from "./nlHelperCopy";
import { getApplicationAi } from "../services/ai/applicationAi";
import { useLocalIntelligenceService, type LocalIntelligenceService } from "../services/ai/localIntelligenceView";
import { LocalSearchHelperRow } from "./DownloadedModels";
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

function validDay(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const day = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

/**
 * The download states in which the bytes are still moving.
 *
 * The device QUEUES a transfer before it downloads it, and it VERIFIES the
 * bytes before it calls the model installed. All three states are "the
 * transfer is running": a reader who clicks Download and is then offered "Not
 * now" would strand a running transfer with no progress and no error line.
 */
const TRANSFER_IN_FLIGHT = new Set(["queued", "downloading", "verifying"]);

/**
 * The explicit offer: the canonical helper lifecycle row plus a way out.
 *
 * A DOWNLOAD IN PROGRESS KEEPS THE OFFER ON SCREEN. The transfer belongs to
 * the device, not to this offer: unmounting the row while the bytes move
 * would leave a running download with no progress and no error line. So
 * "Not now" is not offered while a transfer runs, and the screen is told that
 * a transfer is running so a new Smart Search cannot hide the offer either.
 */
function SearchHelperSetup({ service = getApplicationAi(), onDismiss, onTransferChange }: {
  service?: LocalIntelligenceService;
  onDismiss: () => void;
  onTransferChange?: (running: boolean) => void;
}) {
  const { helper, phase } = useLocalIntelligenceService(service);
  const modelId = helper?.modelId;
  // The row's own operation counts as a running transfer. The device registers
  // the transfer a tick AFTER the reader asks for it, so the status alone
  // leaves a window in which a click would still be offered a way out — and
  // taking that way out would strand a download the device has already
  // started. The row knows it is busy from the click itself.
  const [rowBusy, setRowBusy] = useState(false);
  const rowBusyRef = useRef(false);
  const handleRowBusy = useCallback((busy: boolean) => {
    rowBusyRef.current = busy;
    setRowBusy(busy);
  }, []);
  const statusInFlight = Boolean(
    modelId && TRANSFER_IN_FLIGHT.has(service.manager.statusOf(modelId)?.download ?? ""),
  );
  const transferRunning = statusInFlight || rowBusy;
  useEffect(() => {
    onTransferChange?.(transferRunning);
    return () => {
      // The transfer belongs to the DEVICE, not to this offer. If the offer
      // unmounts while the bytes are still moving, the screen must still know
      // that a transfer runs — otherwise a later Smart Search would hide the
      // offer and strand it.
      const stillRunning = Boolean(
        modelId && TRANSFER_IN_FLIGHT.has(service.manager.statusOf(modelId)?.download ?? ""),
      );
      onTransferChange?.(stillRunning || rowBusyRef.current);
    };
  }, [onTransferChange, transferRunning, modelId, service]);
  return <div className="w-full min-w-0">
    <LocalSearchHelperRow
      service={service}
      descriptor={helper}
      phase={phase}
      description={null}
      onBusyChange={handleRowBusy}
    />
    {!transferRunning && (
      <button type="button" onClick={onDismiss} className="min-h-[44px] px-2 text-sm font-medium text-on-surface underline">Not now</button>
    )}
  </div>;
}

export function SearchScreen(props: {
  /** Injected NL extractor (test fakes or a live extractNlFilters composer).
   * Absent means the live transport. Explicit undefined keeps smart search
   * unavailable: the button stays disabled and nothing is ever guessed. */
  nlExtract?: (input: string) => Promise<NlFilterPatch>;
  helperService?: LocalIntelligenceService;
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
  // Ordinary and extracted dates share controls and the same URL contract.
  const [dateFromParam, setDateFromParam] = useUrlParam("dateFrom");
  const [dateToParam, setDateToParam] = useUrlParam("dateTo");
  // Each bound is judged on its own: one impossible day must not throw away
  // the other, valid one. Only a reversed range invalidates both.
  const fromParamUsable = !dateFromParam || validDay(dateFromParam);
  const toParamUsable = !dateToParam || validDay(dateToParam);
  const reversedRange = Boolean(
    fromParamUsable && toParamUsable && dateFromParam && dateToParam &&
    dateFromParam > dateToParam,
  );
  const invalidDates = !fromParamUsable || !toParamUsable || reversedRange;
  // The APPLIED bounds. The chips, the filter count and the feed all use
  // these, so a value the feed never received can never be counted as a
  // filter the reader has on.
  const dateFrom = fromParamUsable && !reversedRange ? dateFromParam : "";
  const dateTo = toParamUsable && !reversedRange ? dateToParam : "";
  const [, setSearchParams] = useSearchParams();
  const [clearingFilters, setClearingFilters] = useState(false);
  function clearSearchFilters() {
    advanced.clearAll();
    setDateFromParam("");
    setDateToParam("");
    setClearingFilters(true);
  }
  // Finish a combined clear atomically; independent URL effects must not
  // resurrect a sibling filter from their old rendered location.
  useEffect(() => {
    if (!clearingFilters) return;
    setClearingFilters(false);
    setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      for (const key of ["category", "status", "sort", "dateFrom", "dateTo"]) next.delete(key);
      return next;
    }, { replace: true });
  }, [clearingFilters, setSearchParams]);
  // NL smart search: extracted values land in the ordinary editable
  // controls above (query field, filter chips), never applied blindly.
  const [nlInput, setNlInput] = useState("");
  const [nlBusy, setNlBusy] = useState(false);
  const [nlNote, setNlNote] = useState<string | null>(null);
  // True only when an empty result means "the helper isn't set up here", not
  // "the helper looked and found nothing". Those two are different truths and
  // must not share copy (CF-040 F6).
  const [nlHelperMissing, setNlHelperMissing] = useState(false);
  // True while the helper's transfer is running. The offer stays on screen
  // then: a running download with no progress line and no error line is a
  // download the reader cannot see.
  // The transfer state lives in a REF, not in state. The offer reports it, and
  // the decision "may I hide the offer now?" is taken inside an event
  // handler: a state value would be one render behind the offer's report, and
  // a stale "no transfer" would hide a running download with no progress line
  // and no error line. A ref is read at the moment of the decision.
  const helperTransferRef = useRef(false);
  const handleTransferChange = useCallback((running: boolean) => {
    helperTransferRef.current = running;
  }, []);
  // A delayed convenience layer must never replace a newer ordinary search —
  // but only a NEWER SEARCH makes an answer stale. Changing a FILTER while
  // Smart Search works is not a new search: the words are still the reader's
  // words, so the answer may not be thrown away and the phrase may not be
  // lost. The extracted FILTERS are simply not applied over a filter the
  // reader changed in the meantime.
  const ordinaryQueryRef = useRef(query);
  ordinaryQueryRef.current = query;
  const filterContext = JSON.stringify([type, advanced.category, advanced.status, advanced.sort, dateFrom, dateTo]);
  const filterContextRef = useRef(filterContext);
  filterContextRef.current = filterContext;
  const nlRequest = useRef(0);
  useEffect(() => () => { nlRequest.current += 1; }, []);

  async function applyNlFilters() {
    const text = nlInput.trim();
    if (nlExtract === undefined || nlBusy || text === "") return;
    const request = ++nlRequest.current;
    const queryAtRequest = ordinaryQueryRef.current;
    const filtersAtRequest = filterContextRef.current;
    // Alive means: this answer still belongs to the search the reader is
    // looking at. A newer ordinary query is a newer search, so that answer is
    // dropped; unmounting drops it too.
    const alive = () => request === nlRequest.current && ordinaryQueryRef.current === queryAtRequest;
    setNlBusy(true);
    setNlNote(null);
    // The offer is only hidden when nothing is downloading: a transfer in
    // flight has to keep its progress line and its error line.
    if (!helperTransferRef.current) setNlHelperMissing(false);
    try {
      const patch = await nlExtract(text);
      if (!alive()) return;
      const hasFilters = Object.values(patch).some(value => value !== undefined && value !== "");
      const helperState = hasFilters ? "ready" : await nlHelperState();
      if (!alive()) return;
      // The reader changed the filters while this answer was coming: its
      // filters are not applied over the reader's own choice, but the words
      // still are.
      const filtersChanged = filterContextRef.current !== filtersAtRequest;
      // Search always has a useful text query even when extraction is silent.
      setQuery(patch.query?.trim() || text);
      let applied = 0;
      let rejected = 0;
      if (patch.query?.trim()) {
        applied += 1;
      }
      if (!filtersChanged) {
        if (patch.category !== undefined) {
          advanced.setCategory(patch.category);
          applied += 1;
        }
        if (patch.status !== undefined) {
          advanced.setStatus(patch.status);
          applied += 1;
        }
        // A date that is not a real day is not a filter. It is refused here,
        // before it can reach the URL, and it is not counted as applied.
        const fromReal = patch.dateFrom === undefined || validDay(patch.dateFrom);
        const toReal = patch.dateTo === undefined || validDay(patch.dateTo);
        const reversed =
          patch.dateFrom !== undefined && patch.dateTo !== undefined &&
          fromReal && toReal && patch.dateFrom > patch.dateTo;
        if (patch.dateFrom !== undefined) {
          if (fromReal && !reversed) {
            setDateFromParam(patch.dateFrom);
            applied += 1;
          } else {
            rejected += 1;
          }
        }
        if (patch.dateTo !== undefined) {
          if (toReal && !reversed) {
            setDateToParam(patch.dateTo);
            applied += 1;
          } else {
            rejected += 1;
          }
        }
      }
      // The offer is only hidden when nothing is downloading: a transfer in
      // flight has to keep its progress line and its error line.
      if (!helperTransferRef.current) {
        setNlHelperMissing(applied === 0 && helperState === "not-set-up");
      }
      if (filtersChanged) {
        setNlNote(NL_SEARCH_FILTERS_CHANGED_NOTE);
      } else if (rejected > 0) {
        setNlNote(NL_SEARCH_INVALID_DATE_NOTE);
      } else {
        setNlNote(
          applied === 0
            ? NL_EMPTY_PATCH_NOTE[helperState]
            : nlSearchAppliedNote(applied),
        );
      }
    } catch {
      if (!alive()) return;
      setQuery(text);
      setNlNote(NL_SEARCH_FAILED_NOTE);
    } finally {
      if (request === nlRequest.current) setNlBusy(false);
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

      {/* The filter column is a BOUNDED scroll region, and that bound is a
          promise to the reader: nothing in this column can end up clipped and
          unreachable by touch. The app's viewport never scrolls (the route owns
          the scroller), so at 320 dp with 200 % text this column is taller
          than the screen — the Filters trigger, the offer's Download button
          and the way out would otherwise be cut off below the fold with no way
          to reach them. The column scrolls instead, and the results keep the
          rest of the screen.

          The cap is a share of THIS column's real parent, not a share of the
          viewport: a viewport fraction (60dvh) also cut the Filters trigger at
          320 dp / 125 % text, where the column fits comfortably inside the
          screen and should not have scrolled at all. 75 % of the parent leaves
          the column whole at 125 % and still bounds it at 200 %. */}
      <section
        aria-label="Search filters"
        className="flex max-h-[75%] min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain px-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <motion.label
            layout
            transition={motionSprings.soft}
            className="relative block min-w-0 flex-1 basis-[160px]"
          >
            <Search
              size={16}
              aria-hidden
              className="pointer-events-none absolute left-[14px] top-1/2 -translate-y-1/2 text-on-surface-variant"
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
              className="w-full rounded-m3-sm border border-outline-variant bg-surface py-3 pl-[40px] pr-[56px] text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
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
                   className="absolute right-[4px] top-1/2 flex min-h-[48px] min-w-[48px] -translate-y-1/2 items-center justify-center rounded-full text-on-surface-variant"
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

        <div className="flex flex-wrap items-center gap-2">
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
            className="min-w-0 flex-1 basis-[128px] rounded-m3-sm border border-outline-variant bg-surface px-3 py-3 text-sm placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
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
          </div>
        )}
        {/* The offer is NOT inside the note row. The note comes and goes with
            every Smart Search, and the offer has to survive it: a transfer in
            flight owns its progress line and its error line, and the reader
            must still be able to see (and not strand) the bytes that move. */}
        {nlHelperMissing && (
          <div className="flex flex-wrap items-center gap-2" data-testid="smart-search-offer-row">
            <SearchHelperSetup service={props.helperService} onTransferChange={handleTransferChange} onDismiss={() => {
              setNlHelperMissing(false);
              searchInputRef.current?.focus();
            }} />
          </div>
        )}

        {invalidDates && <p role="alert" className="text-sm text-error">Choose a valid date range: use real days, with the start date on or before the end date.</p>}
        <AdvancedSearchFilters
          filters={{ ...advanced, clearAll: clearSearchFilters }}
          dateRange={{
            from: dateFrom,
            to: dateTo,
            // The FIELDS show what the reader entered (a reversed range can
            // then be fixed); the CHIPS count the applied bounds, so a filter
            // the feed never received is never counted.
            draftFrom: validDay(dateFromParam) ? dateFromParam : dateFrom,
            draftTo: validDay(dateToParam) ? dateToParam : dateTo,
            onFromChange: setDateFromParam,
            onToChange: setDateToParam,
          }}
        />
      </section>

      {/* The results keep a floor of their own. The column above is bounded so
          it can never be taller than the screen, but a bound that eats the
          whole screen would leave the reader with a sliver of a list and no
          way to tell an empty search from a broken one. The floor holds the
          list at a usable height, and the column gives up the difference. */}
      <div ref={scrollRef} data-testid="search-results-scroller" onScroll={handleResultsScroll} className="min-h-[4rem] flex-1 overflow-y-auto">
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
