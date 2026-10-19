import { useEffect, useRef, useState } from "react";
import { ScrollChrome } from "../../components/ScrollChrome";
import { HomeTopBar } from "../../screens/HomeTopBar";
import { HomeFilterChips, HomeScopeChips } from "../../screens/HomeFilterChips";
import { FiltersIconButton } from "../../screens/AdvancedSearchFilters";
import { FixtureFrame, FixtureSection } from "../FixtureSection";

/**
 * CF-010 §3-§5 chrome preflight.
 *
 * The Home screen itself is data-bound (auth + live queries), so the chrome is
 * reviewed here through the *production* pieces it is built from: the real
 * `ScrollChrome` wrapper (which owns the collapse geometry, the reduced-motion
 * override and the `inert` contract), the real search bar, the real filter and
 * scope chips, and the real filter trigger. Only the state is local to this
 * file — every visual decision still belongs to production code.
 *
 * The `hidden` prop is exactly what `nextScrollChrome` returns on the Home
 * screen, so the collapsed/expanded frames below are the two states the reader
 * actually sees, not a CSS approximation of them.
 */

function ChromeContent({
  initialQuery = "",
  compact = false,
}: {
  initialQuery?: string;
  compact?: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [searchFocused, setSearchFocused] = useState(false);
  // Mirrors Home: a live query keeps the field in place, an idle Home shows the
  // title row. The fixture only supplies the state; the bar is production code.
  const expanded = searchFocused || query.length > 0;
  const [type, setType] = useState<"ALL" | "LOST" | "FOUND">("ALL");
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Focus must move on the state change here too, exactly as Home.tsx does it;
  // otherwise this preflight surface renders the opened field *unfocused* and
  // cannot show the production open state (no caret, no focus ring).
  useEffect(() => {
    if (searchFocused) inputRef.current?.focus();
  }, [searchFocused]);
  return (
    <>
      <header
        data-testid="fixture-chrome-toolbar"
        className="border-b border-outline-variant pt-5 shadow-sm"
      >
        <div className="px-4">
          <HomeTopBar
            expanded={expanded}
            compact={compact}
            query={query}
            onQueryChange={setQuery}
            onOpen={() => setSearchFocused(true)}
            onClear={() => setQuery("")}
            onClose={() => {
              setQuery("");
              setSearchFocused(false);
            }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onBrandTap={() => undefined}
            inputRef={inputRef}
            filterButton={
              <FiltersIconButton activeCount={2} open={false} onClick={() => undefined} />
            }
          />
        </div>
      </header>
      <div className="flex flex-col gap-3 px-4">
        <div className="fb-scroll-fade">
          <div className="fb-scroll-row flex items-center gap-3" aria-label="Feed filters">
            <HomeFilterChips value={type} onChange={setType} />
            <span aria-hidden className="h-6 shrink-0 border-l border-outline-variant" />
            <HomeScopeChips
              nearbyActive={false}
              nearbyRadiusKm={5}
              onNearbyTap={() => undefined}
              onOpenTap={() => undefined}
              onRecentTap={() => undefined}
            />
          </div>
        </div>
      </div>
    </>
  );
}

/** The frame body: a short page so the collapsed/expanded difference is visible. */
function ChromePage({
  hidden,
  compact = false,
  initialQuery = "",
}: {
  hidden: boolean;
  compact?: boolean;
  initialQuery?: string;
}) {
  return (
    <div className="flex h-64 flex-col gap-4 overflow-hidden">
      <ScrollChrome hidden={hidden} testId="fixture-chrome">
        <ChromeContent initialQuery={initialQuery} compact={compact} />
      </ScrollChrome>
      <div className="flex flex-1 items-start justify-center px-4 text-sm text-on-surface-variant">
        <span data-testid="fixture-chrome-feed-body">Feed content starts here</span>
      </div>
    </div>
  );
}

/**
 * Fixture-level control: the collapse is a motion, so a screenshot alone cannot
 * prove it. This frame lets a reviewer toggle it and watch, and lets the review
 * script sample the height mid-animation (motion allowed) versus instantly
 * (reduced motion).
 *
 * The second control drives the *first stage* of the same collapse — the brand
 * row's wordmark (owner ruling 2026-10-19). It is the same production prop Home
 * passes from `nextScrollChrome`, so what a reviewer toggles here is the state
 * the reader actually gets, not a CSS lookalike. The two controls are separate
 * because the stages are: the word leaves before the bar does, and on the way
 * back the bar arrives with the mark alone before the name returns.
 */
function ChromeTogglePage() {
  const [hidden, setHidden] = useState(false);
  const [compact, setCompact] = useState(false);
  return (
    <div className="flex h-72 flex-col gap-4 overflow-hidden">
      <div className="mx-3 flex self-start gap-2">
        <button
          type="button"
          data-testid="fixture-chrome-toggle"
          onClick={() => setHidden((value) => !value)}
          className="rounded-m3-sm border border-outline-variant px-3 py-1 text-xs font-medium"
        >
          Toggle chrome
        </button>
        <button
          type="button"
          data-testid="fixture-compact-toggle"
          onClick={() => setCompact((value) => !value)}
          className="rounded-m3-sm border border-outline-variant px-3 py-1 text-xs font-medium"
        >
          Toggle wordmark
        </button>
      </div>
      <ScrollChrome hidden={hidden} testId="fixture-chrome-toggle-shell">
        <ChromeContent compact={compact} />
      </ScrollChrome>
      <div className="flex flex-1 items-start justify-center px-4 text-sm text-on-surface-variant">
        <span>Feed content starts here</span>
      </div>
    </div>
  );
}

export function ChromeFixtures() {  return (
    <FixtureSection
      id="home-chrome"
      title="Home chrome (collapsing)"
      description="Production ScrollChrome wrapper + search bar + filter/scope chips, in the expanded and collapsed states the reader actually gets, plus the reduced-motion collapse."
    >
      <FixtureFrame section="home-chrome" variant="normal">
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          Expanded (top of feed, or any upward scroll)
        </p>
        <ChromePage hidden={false} />
      </FixtureFrame>
      <FixtureFrame section="home-chrome" variant="loading">
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          Collapsed (intentional downward scroll) — the feed gains the room
        </p>
        <ChromePage hidden />
      </FixtureFrame>
      <FixtureFrame section="home-chrome" variant="empty">
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          Long query typed: the bar stays one row, clear stays reachable
        </p>
        <ChromePage
          hidden={false}
          initialQuery="black leather weekender bag with brass zips"
        />
      </FixtureFrame>
      <FixtureFrame section="home-chrome" variant="error">
        <ChromePage hidden={false} />
      </FixtureFrame>
      <FixtureFrame section="home-chrome" variant="long-content">
        <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          Interactive (fixture control): toggle to watch the collapse — instant
          under reduced motion
        </p>
        <ChromeTogglePage />
      </FixtureFrame>
      <FixtureFrame section="home-chrome" variant="large-text">
        <ChromePage hidden={false} />
      </FixtureFrame>
      <FixtureFrame section="home-chrome" variant="dark">
        <ChromePage hidden={false} />
      </FixtureFrame>
      <FixtureFrame section="home-chrome" variant="amoled">
        <ChromePage hidden={false} />
      </FixtureFrame>
      <FixtureFrame section="home-chrome" variant="small-width">
        <ChromePage hidden={false} />
      </FixtureFrame>
    </FixtureSection>
  );
}
