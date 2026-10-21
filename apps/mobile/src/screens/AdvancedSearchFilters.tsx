import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { CATEGORIES, POST_STATUSES, type Category, type PostStatus, type PostType } from "@findback/shared";
import { SlidersHorizontal, X } from "lucide-react";
import { BottomSheet } from "../components/BottomSheet";
import { CategoryField } from "../components/CategoryField";
import { SelectField, TextField } from "../components/Fields";
import { STATUS_OPTIONS, statusLabel } from "../components/Segmented";
import { useUrlParam } from "../hooks/useUrlParam";
import { MAX_PLACE_CHARS, placeRejection, type PlaceRejection } from "../services/search/placeScope";
import {
  fadeVariants,
  motionDurations,
  motionEasings,
  motionSprings,
  pressFeedback,
  scaleInVariants,
} from "../components/uiMotion";

/** The first value that is actually there: an empty string is "not there". */
function firstPresent(...values: (string | undefined)[]): string {
  for (const value of values) if (value) return value;
  return "";
}

/**
 * Why the reader's text is not a place — one sentence per reason.
 *
 * A single sentence that named the wrong reason would be a sentence about
 * something else: a coordinate, a bare number and an over-long name are
 * three different mistakes, and the reader is told which one they made.
 */
export const PLACE_REJECTION_COPY: Record<PlaceRejection, string> = {
  coordinate: "A map coordinate is not a place — type the place's name.",
  number: "Type the name of a place, not a number.",
  "too-long": `That place name is too long — keep it under ${MAX_PLACE_CHARS} characters.`,
};

/** Keep the legacy /search and Home filter URL contract identical. */
export function useAdvancedSearchFilters() {
  const [categoryParam, setCategory] = useUrlParam("category");
  const category: Category | "" = (CATEGORIES as readonly string[]).includes(categoryParam) ? categoryParam as Category : "";
  const [statusParam, setStatus] = useUrlParam("status");
  const status: PostStatus | "" = (POST_STATUSES as readonly string[]).includes(statusParam) ? statusParam as PostStatus : "";
  const [sortParam, setSortParam] = useUrlParam("sort");
  const sort: "newest" | "oldest" = sortParam === "oldest" ? "oldest" : "newest";
  const setSort = (next: "newest" | "oldest") => setSortParam(next === "newest" ? "" : next);

  const [, setParams] = useSearchParams();
  const [pendingClear, setPendingClear] = useState(false);
  function clearAll() {
    setCategory("");
    setStatus("");
    setSort("newest");
    setPendingClear(true);
  }
  // useUrlParam effects write from the same rendered location. Apply the
  // combined delete last so simultaneous clear-all cannot resurrect a param.
  useEffect(() => {
    if (!pendingClear) return;
    setPendingClear(false);
    setParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete("category");
      next.delete("status");
      next.delete("sort");
      return next;
    }, { replace: true });
  }, [pendingClear, setParams]);

  return { category, status, sort, setCategory, setStatus, setSort, clearAll };
}

export type AdvancedFilters = ReturnType<typeof useAdvancedSearchFilters>;

/** Number of active advanced filters (drives the trigger badge). */
export function getActiveFilterCount(filters: AdvancedFilters): number {
  return (
    (filters.category ? 1 : 0) +
    (filters.status ? 1 : 0) +
    (filters.sort !== "newest" ? 1 : 0)
  );
}

/**
 * Compact filter icon-button trigger variant: lives INSIDE the search bar at
 * its left edge and opens the same BottomSheet. Same press language as every
 * other icon-button; the active-count badge is decorative (the accessible
 * name carries the count).
 */
export function FiltersIconButton({
  activeCount,
  open,
  onClick,
}: {
  activeCount: number;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={activeCount > 0 ? `Filters, ${activeCount} active` : "Filters"}
      whileTap={pressFeedback.iconButton}
      transition={{ duration: motionDurations.instant }}
      className="relative flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container"
    >
      <SlidersHorizontal size={18} aria-hidden />
      <AnimatePresence initial={false}>
        {activeCount > 0 && (
          <motion.span
            // Stable key: count updates swap the label text only and never
            // replay the badge entrance (modest change, no bouncing button).
            key="filters-badge"
            aria-hidden="true"
            data-testid="filters-active-count"
            variants={scaleInVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
            className="absolute right-0.5 top-0.5 flex min-h-[20px] min-w-[20px] items-center justify-center rounded-full bg-on-surface px-1 text-[11px] font-semibold text-surface"
          >
            {activeCount}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

export function AdvancedSearchFilters({
  filters,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  dateRange,
  postType,
  place,
}: {
  filters: AdvancedFilters;
  /** Controlled sheet state (Home embeds its own trigger inside the search bar). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the default full-width trigger when the caller renders its own. */
  hideTrigger?: boolean;
  /** Search can expose dates without changing Home's filter/URL contract. */
  dateRange?: {
    /** The APPLIED bounds. The chips count these: a value the feed never
     *  received must never be counted as a filter the reader has on. */
    from: string;
    to: string;
    /** What the date FIELDS show. Defaults to the applied bounds. A range the
     *  reader entered but that is not applied (a reversed range) is shown as
     *  entered, so the mistake can be fixed instead of silently vanishing. */
    draftFrom?: string;
    draftTo?: string;
    onFromChange: (value: string) => void;
    onToChange: (value: string) => void;
  };
  /**
   * The LOST/FOUND type, shown as a chip next to the other active filters.
   *
   * The type CONTROL lives on the screen (the segmented control), so this
   * is a state summary and a way out — the same shape as the date chips.
   * Omitted (Home) leaves the type out of the sheet and the chips.
   */
  postType?: {
    value: PostType | "";
    onChange: (value: PostType | "") => void;
  };
  /**
   * The place filter: a place NAME, matched against the place field of a
   * report on the device. Omitted (Home) leaves the place out of the sheet
   * and the chips.
   */
  place?: {
    /** What the field shows: the reader's own text. */
    value: string;
    /** The place that is IN FORCE. Empty when the text is not a place. */
    applied: string;
    onChange: (value: string) => void;
  };
}) {
  const { category, status, sort, setCategory, setStatus, setSort, clearAll } = filters;
  const [internalOpen, setInternalOpen] = useState(false);
  const sheetOpen = controlledOpen ?? internalOpen;
  const setSheetOpen = onOpenChange ?? setInternalOpen;
  // The date FIELDS may show what the reader entered even when that range is
  // not applied (a reversed range), so the mistake can be fixed instead of
  // silently vanishing. The CHIPS keep the applied bounds. An EMPTY draft
  // means "no draft": it falls back to the applied bound, so a caller that
  // has no draft to offer still shows what is in force.
  const dateFromField = firstPresent(dateRange?.draftFrom, dateRange?.from);
  const dateToField = firstPresent(dateRange?.draftTo, dateRange?.to);
  const active = [
    category ? { key: "category", label: `Category: ${category}`, clear: () => setCategory("") } : null,
    status ? { key: "status", label: `Status: ${statusLabel(status)}`, clear: () => setStatus("") } : null,
    sort !== "newest" ? { key: "sort", label: "Sort: Oldest first", clear: () => setSort("newest") } : null,
    dateRange?.from ? { key: "start date", label: `From: ${dateRange.from}`, clear: () => dateRange.onFromChange("") } : null,
    dateRange?.to ? { key: "end date", label: `To: ${dateRange.to}`, clear: () => dateRange.onToChange("") } : null,
    place?.applied ? { key: "place", label: `Place: ${place.applied}`, clear: () => place.onChange("") } : null,
  ].filter((item): item is { key: string; label: string; clear: () => void } => item !== null);
  // The TYPE is a filter too, and it is a chip in the same row as the others:
  // the badge counts it, so a reader with only a type filter never sees a
  // chip on screen and no count beside it.
  const typeActive = Boolean(postType?.value);
  const activeCount = active.length + (typeActive ? 1 : 0);

  return (
    <>
      {!hideTrigger && (
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-m3-sm border border-outline-variant bg-surface px-4 text-sm font-medium text-on-surface"
        >
          <SlidersHorizontal size={16} aria-hidden />
          Filters{activeCount > 0 ? ` (${activeCount})` : ""}
        </button>
      )}

      {/* The chips row.
          The TYPE chip lives OUTSIDE the animated group, and the group is
          mounted only while an advanced filter is on. Two reasons:
          clearing every advanced filter must take the cleared chips off the
          screen at once — they must not keep the cleared chips on screen
          while they fade out — and the type chip is its own summary, so it
          fades in and out on its own. */}
      {(active.length > 0 || typeActive) && (
        <motion.div
          layout
          transition={motionSprings.snappy}
          className="flex flex-wrap items-center gap-2"
          aria-label="Active filters"
        >
          <AnimatePresence initial={false}>
            {typeActive && (
              <motion.button
                key="type"
                layout
                type="button"
                onClick={() => postType?.onChange("")}
                aria-label="Remove type filter"
                whileTap={pressFeedback.button}
                variants={fadeVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
                className="inline-flex min-h-[48px] items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container px-3 text-sm text-on-surface"
              >
                Type: {postType?.value === "LOST" ? "Lost" : "Found"}<X size={14} aria-hidden />
              </motion.button>
            )}
          </AnimatePresence>
          {active.length > 0 && (
            <AnimatePresence initial={false}>
              {active.map(item => (
                <motion.button
                  key={item.key}
                  layout
                  type="button"
                  onClick={item.clear}
                  aria-label={`Remove ${item.key} filter`}
                  whileTap={pressFeedback.button}
                  variants={fadeVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
                  className="inline-flex min-h-[48px] items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container px-3 text-sm text-on-surface"
                >
                  {item.label}<X size={14} aria-hidden />
                </motion.button>
              ))}
            </AnimatePresence>
          )}
          {activeCount > 0 && (
            <button type="button" onClick={clearAll} className="inline-flex min-h-[48px] items-center rounded-full px-3 text-sm font-medium text-on-surface underline">
              Clear all filters
            </button>
          )}
        </motion.div>
      )}

      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Filters"
        description={dateRange ? "Changes apply immediately." : "Category, status and sort. Changes apply immediately."}
        height={dateRange ? "large" : "medium"}
      >
        <div className="flex flex-col gap-3 pb-2">
          <CategoryField value={category} onChange={setCategory} />
          <SelectField label="Status" value={status} onChange={e => setStatus(e.target.value as PostStatus | "")} options={STATUS_OPTIONS} />
          {dateRange && <>
            <TextField label="From date" type="date" style={{ paddingInline: 12 }} value={dateFromField} max={dateToField || undefined} onChange={e => dateRange.onFromChange(e.target.value)} />
            <TextField label="To date" type="date" style={{ paddingInline: 12 }} value={dateToField} min={dateFromField || undefined} onChange={e => dateRange.onToChange(e.target.value)} />
          </>}
          {place && (
            <TextField
              label="Place"
              placeholder="e.g. Gulshan"
              value={place.value}
              hint="Keeps the loaded reports whose place name matches — the place is matched on this device, so more reports may match as you load them. A report with only a map pin and no place name is not included."
              // A value that is not a place name (a coordinate, a bare
              // number, a name that is too long) is not a filter. The reader
              // is told WHICH reason it is, instead of watching a filter
              // that never applies.
              error={
                placeRejection(place.value)
                  ? PLACE_REJECTION_COPY[placeRejection(place.value)!]
                  : undefined
              }
              onChange={e => place.onChange(e.target.value)}
            />
          )}
          <SelectField label="Sort" value={sort} onChange={e => setSort(e.target.value as "newest" | "oldest")} options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
          ]} />
          {activeCount > 0 && (
            <button type="button" onClick={clearAll} className="inline-flex min-h-[48px] items-center justify-center rounded-m3-sm border border-outline-variant px-4 text-sm font-medium">
              Clear all filters
            </button>
          )}
        </div>
      </BottomSheet>
    </>
  );
}
