import type { ReactNode, RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, X } from "lucide-react";
import {
  fadeVariants,
  motionDurations,
  motionEasings,
  motionSprings,
  pressFeedback,
  scaleInVariants,
} from "../components/uiMotion";

/**
 * Home-only search row (reference-inspired redesign): a large friendly
 * capsule — search icon left, filter affordance right — instead of the
 * previous compact utility input. Purely presentational: debounce, URL sync,
 * clear/cancel and the advanced-filter sheet stay owned by Home with the
 * same accessible names (`Search posts`, `Clear search`, `Cancel`).
 */
export function HomeSearchBar({
  query,
  onQueryChange,
  searchActive,
  onClear,
  onCancel,
  onFocus,
  onBlur,
  inputRef,
  filterButton,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  searchActive: boolean;
  onClear: () => void;
  onCancel: () => void;
  onFocus: () => void;
  onBlur: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  filterButton: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <motion.div
        layout
        transition={motionSprings.soft}
        className="flex min-h-[52px] min-w-0 flex-1 items-center rounded-[20px] border border-outline-variant bg-surface-container-low pl-4 pr-1.5 focus-within:border-on-surface"
      >
        <Search size={20} aria-hidden className="pointer-events-none shrink-0 text-on-surface-variant" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder="Search lost or found items…"
          aria-label="Search posts"
          className="min-w-0 flex-1 bg-transparent py-3.5 pl-2.5 pr-1 text-[15px] placeholder:text-on-surface-variant focus:outline-none"
        />
        <AnimatePresence initial={false}>
          {query.length > 0 && (
            <motion.button
              key="home-search-clear"
              type="button"
              onClick={onClear}
              aria-label="Clear search"
              whileTap={pressFeedback.iconButton}
              variants={scaleInVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
              className="flex min-h-[48px] min-w-[48px] shrink-0 items-center justify-center rounded-full text-on-surface-variant"
            >
              <X size={16} aria-hidden />
            </motion.button>
          )}
        </AnimatePresence>
        {filterButton}
      </motion.div>
      <AnimatePresence initial={false}>
        {searchActive && (
          <motion.button
            key="home-search-cancel"
            type="button"
            onClick={onCancel}
            variants={fadeVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
            className="flex min-h-[48px] shrink-0 items-center rounded-full px-2 text-sm font-medium text-on-surface"
          >
            Cancel
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
