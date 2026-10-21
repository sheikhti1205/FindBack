import type { ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Search, X } from "lucide-react";
import { BrandMark } from "../components/BrandMark";
import { motionDurations, motionEasings, pressFeedback, scaleInVariants } from "../components/uiMotion";

/** Shared swap timing for the one-row state change. */
const swap = { duration: motionDurations.fast, ease: motionEasings.out } as const;

/**
 * Home's app bar (owner redesign, 2026-10-19): ONE compact row — brand mark plus
 * wordmark as the title unit, with the essential actions trailing.
 *
 * The search field is deliberately not resident. The row holds either the title
 * unit or the field, never both, so an idle Home spends its vertical space on
 * the feed; the field appears only on an explicit activation and returns focus
 * to its trigger on close. The permanent result/account line that used to sit
 * under the title is gone: account identity lives in the profile surface, and a
 * result count was duplicate chrome on every visit.
 *
 * Motion: a crossfade of the same slot at `motionDurations.fast` (150ms) — the
 * app's existing state-acknowledgement token, which matches Material's
 * fast-effects Web conversion. It is intentionally NOT a container transform:
 * Material's published 300/250ms pair belongs to a *linked* SearchBar→SearchView
 * expansion, which this is not, and no first-party source requires a wordmark to
 * morph into the field. Reduced motion keeps the crossfade and drops the
 * x-offset — the app-root MotionConfig degrades transform travel while keeping
 * opacity, so nothing here needs a second reduced-motion branch. Focus is moved
 * on the state change, never after the animation.
 *
 * Geometry: both states are exactly 48px tall, so the state change swaps the row
 * rather than resizing it and the chips row below never moves. The pill's 1px
 * border sits inside that 48px (border-box) and every child stays under it. The
 * focus ring is drawn on the pill, not on the input — see
 * `index.css` `.fb-home-search-field`.
 */
export function HomeTopBar({
  expanded,
  compact,
  query,
  onQueryChange,
  onOpen,
  onClear,
  onClose,
  onFocus,
  onFieldBlur,
  onBlur,
  onBrandTap,
  inputRef,
  filterButton,
}: {
  expanded: boolean;
  /**
   * The reader has scrolled the feed away: the brand row shows the mark alone.
   * Owner ruling 2026-10-19 — the Threads behaviour, where the word leaves and
   * comes back. It is the first stage of the chrome collapse (`scrollChrome.ts`).
   * It is consumed only by the brand branch: the field branch replaces that row
   * entirely, so a typed-but-unfocused query (which keeps the field mounted
   * while the chrome is not pinned) never shows the mark-only stage.
   */
  compact: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onOpen: () => void;
  onClear: () => void;
  onClose: () => void;
  onFocus: () => void;
  /**
   * The *text field* lost focus, which is not the same event as the row losing
   * focus: Close, Clear and Filters live inside the row, so tabbing to them
   * blurs the input while the row keeps focus. Home arms the Android-Back
   * interceptor on this signal, because a typed-but-unfocused query is a
   * browsing filter by then (review HOME-SCROLL-FIXFORWARD-R2 MINOR-1).
   */
  onFieldBlur: () => void;
  onBlur: () => void;
  onBrandTap: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  /** The advanced-filter trigger; stays mounted in both states so it never moves. */
  filterButton: ReactNode;
}) {
  // Closing unmounts the control that held focus, so focus is handed back to the
  // affordance that opened it instead of being dropped on <body> (WCAG 2.4.3).
  // A query restored from the URL mounts already expanded and must not steal
  // focus, so the first paint is never a transition.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(expanded);
  useEffect(() => {
    if (wasExpanded.current && !expanded) triggerRef.current?.focus();
    wasExpanded.current = expanded;
  }, [expanded]);

  return (
    <div
      data-testid="home-search-row"
      className="flex min-h-[48px] items-center gap-1"
      onBlur={(event) => {
        // Close/Clear/Filters are part of the same interaction. Collapsing an
        // empty field on the input's blur moves Filters between pointer-down
        // and pointer-up, and unmounts Close during keyboard navigation.
        // `relatedTarget` is an `EventTarget`, not necessarily a `Node`; a
        // non-Node value must fall through to the blur path rather than throw
        // (review HOME-SCROLL-FIXFORWARD-R2 NIT-3).
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) onBlur();
      }}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {expanded ? (
          <motion.div
            key="field"
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -6 }}
            transition={swap}
            // Height parity with the title row is the point: the pill's border
            // is inside its 48px min-height (box-border) and every child stays
            // at or below 46px, so opening search never moves the chips row or
            // the feed. The focus ring belongs to the pill — see
            // `index.css` `.fb-home-search-field`, because the app-wide
            // `:focus-visible` rule is unlayered and a utility cannot win.
            className="fb-home-search-field flex min-h-[48px] min-w-0 flex-1 items-center rounded-full border border-outline-variant bg-surface-container-low pr-1 focus-within:border-on-surface"
            data-testid="home-search-field"
          >
            {/* The field replaces the wordmark, so the screen would otherwise
                lose its only heading while searching. */}
            <h1 className="sr-only">FindBack</h1>
            <button
              type="button"
              data-testid="home-search-close"
              aria-label="Close search"
              onClick={onClose}
              className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full text-on-surface-variant"
            >
              {/* An arrow, not a second ✕: "leave the field" and "clear the query"
                  are separate semantics, so they must not look alike. It also
                  matches the Android Back behaviour wired in Home. */}
              <ArrowLeft size={18} aria-hidden />
            </button>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onFocus={onFocus}
              onBlur={onFieldBlur}
              // Short enough to survive the field's 320dp + Extra-large-text
              // width measured in the render harness; the accessible name
              // ("Search posts") carries the same meaning for assistive tech.
              placeholder="Search posts…"
              aria-label="Search posts"
              // Relative font size so the field tracks the app's text-size
              // setting (an absolute px size would stay put at Extra-large).
              //
              // px, not rem: the row's height must not depend on the root font
              // size, or opening search resizes the bar at Extra-large text
              // (rem padding on an 18.75px line pushed the pill to 50.1 of a
              // 48px row). A fixed 44px control inside the pill's 48px keeps
              // rest and open identical at every text size.
              className="h-[44px] min-w-0 flex-1 bg-transparent px-0.5 text-[0.9375rem] placeholder:text-on-surface-variant [&::-webkit-search-cancel-button]:hidden"
            />
            <AnimatePresence initial={false}>
              {query.length > 0 && (
                <motion.button
                  key="home-search-clear"
                  type="button"
                  onClick={() => {
                    onClear();
                    // Clearing is done to retype: without this the button
                    // unmounts and focus falls to <body>, so the next Tab skips
                    // the input entirely (review R2 MINOR-2).
                    inputRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  whileTap={pressFeedback.iconButton}
                  variants={scaleInVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  transition={swap}
                  className="flex min-h-[44px] min-w-[48px] shrink-0 items-center justify-center rounded-full text-on-surface-variant"
                >
                  <X size={16} aria-hidden />
                </motion.button>
              )}
            </AnimatePresence>
          </motion.div>
        ) : (
          <motion.div
            key="brand"
            initial={{ opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 6 }}
            transition={swap}
            className="flex min-w-0 flex-1 items-center"
          >
            <h1 aria-label="FindBack" className="min-w-0 text-base font-semibold tracking-tight">
              <button
                type="button"
                data-testid="home-brand"
                aria-label="FindBack — scroll the feed to the top"
                onClick={onBrandTap}
                className="-ml-1 flex min-h-[48px] min-w-0 items-center gap-2 rounded-m3-sm px-1"
              >
                {/* Decorative beside the wordmark, and the button already
                    carries the accessible name. */}
                <BrandMark size={28} shape="tile" alt="" />
                {/* The wordmark leaves on scroll and returns on the way back
                    (owner ruling 2026-10-19). Only opacity and a small x-shift
                    animate — the span keeps its box, so nothing in the row or
                    the feed reflows, the mark never moves, and the reduced-motion
                    path (which the app root degrades to opacity) needs no branch
                    of its own. It is NOT `aria-hidden` while collapsed: the text
                    is the row's visible name and the heading stays non-empty. */}
                <motion.span
                  data-testid="home-brand-wordmark"
                  data-compact={compact ? "true" : "false"}
                  initial={false}
                  animate={{ opacity: compact ? 0 : 1, x: compact ? -6 : 0 }}
                  transition={swap}
                  className="truncate"
                >
                  FindBack
                </motion.span>
              </button>
            </h1>
          </motion.div>
        )}
      </AnimatePresence>
      {/* The 48px hit areas carry their own padding, so the cluster is pulled
          10px toward the edge to align the trailing icon's optical edge with
          the brand tile instead of reading inset-left / padded-right. */}
      <div className="fb-home-search-actions -mr-2.5 flex shrink-0 items-center">
        {filterButton}
        {/* `popLayout` is load-bearing: the trigger and the field share one flex
            slot. Without it the outgoing trigger keeps its 48px in flow for the
            whole 150ms exit, so the entering pill renders ~48px narrower than it
            settles and snaps wider on the last frame. Popped out, the field owns
            the slot from its first frame.

            Popping alone would put two controls in one place: the filter button
            slides right into the 48px slot the trigger vacates, and the popped
            ghost keeps that same box for its whole exit, later in DOM order. The
            ghost therefore neither paints nor accepts pointer events while it is
            popped (`.fb-home-search-actions [data-motion-pop-id]` in index.css)
            — it hands the slot over at the first frame instead of crossfading on
            top of a live target. `Home.test` samples a tap through the whole
            transition. */}
        <AnimatePresence initial={false} mode="popLayout">
          {!expanded && (
            <motion.button
              key="home-search-open"
              type="button"
              ref={triggerRef}
              data-testid="home-search-open"
              aria-label="Open search"
              onClick={onOpen}
              whileTap={pressFeedback.iconButton}
              variants={scaleInVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              transition={swap}
              className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full text-on-surface"
            >
              <Search size={20} aria-hidden />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
