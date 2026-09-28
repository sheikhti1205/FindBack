import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { CATEGORIES, POST_STATUSES, type Category, type PostStatus } from "@findback/shared";
import { SlidersHorizontal, X } from "lucide-react";
import { BottomSheet } from "../components/BottomSheet";
import { CategoryField } from "../components/CategoryField";
import { SelectField } from "../components/Fields";
import { STATUS_OPTIONS, statusLabel } from "../components/Segmented";
import { useUrlParam } from "../hooks/useUrlParam";
import {
  fadeVariants,
  motionDurations,
  motionEasings,
  motionSprings,
  pressFeedback,
  scaleInVariants,
} from "../components/uiMotion";

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
}: {
  filters: AdvancedFilters;
  /** Controlled sheet state (Home embeds its own trigger inside the search bar). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the default full-width trigger when the caller renders its own. */
  hideTrigger?: boolean;
}) {
  const { category, status, sort, setCategory, setStatus, setSort, clearAll } = filters;
  const [internalOpen, setInternalOpen] = useState(false);
  const sheetOpen = controlledOpen ?? internalOpen;
  const setSheetOpen = onOpenChange ?? setInternalOpen;
  const active = [
    category ? { key: "category", label: `Category: ${category}`, clear: () => setCategory("") } : null,
    status ? { key: "status", label: `Status: ${statusLabel(status)}`, clear: () => setStatus("") } : null,
    sort !== "newest" ? { key: "sort", label: "Sort: Oldest first", clear: () => setSort("newest") } : null,
  ].filter((item): item is { key: string; label: string; clear: () => void } => item !== null);

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
          Filters{active.length > 0 ? ` (${active.length})` : ""}
        </button>
      )}

      {active.length > 0 && (
        <motion.div
          layout
          transition={motionSprings.snappy}
          className="flex flex-wrap items-center gap-2"
          aria-label="Active filters"
        >
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
          <button type="button" onClick={clearAll} className="inline-flex min-h-[48px] items-center rounded-full px-3 text-sm font-medium text-on-surface underline">
            Clear all filters
          </button>
        </motion.div>
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
          <SelectField label="Status" value={status} onChange={e => setStatus(e.target.value as PostStatus | "")} options={STATUS_OPTIONS} />
          <SelectField label="Sort" value={sort} onChange={e => setSort(e.target.value as "newest" | "oldest")} options={[
            { value: "newest", label: "Newest first" },
            { value: "oldest", label: "Oldest first" },
          ]} />
          {active.length > 0 && (
            <button type="button" onClick={clearAll} className="inline-flex min-h-[48px] items-center justify-center rounded-m3-sm border border-outline-variant px-4 text-sm font-medium">
              Clear all filters
            </button>
          )}
        </div>
      </BottomSheet>
    </>
  );
}
