import { useRef, useState } from "react";
import { ScrollChrome } from "../../components/ScrollChrome";
import { BrandMark } from "../../components/BrandMark";
import { HomeSearchBar } from "../../screens/HomeSearchBar";
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

function ChromeContent({ initialQuery = "" }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [type, setType] = useState<"ALL" | "LOST" | "FOUND">("ALL");
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <header
        data-testid="fixture-chrome-toolbar"
        className="border-b border-outline-variant pt-5 shadow-sm"
      >
        <div className="px-4">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">
              <span
                data-testid="fixture-chrome-brand"
                className="-mx-1 flex min-h-[44px] items-center gap-2 rounded-m3-sm px-1"
              >
                <BrandMark size={24} />
                <span>FindBack</span>
              </span>
            </h1>
          </div>
          <p className="text-xs uppercase tracking-wide text-on-surface-variant">128 reports</p>
        </div>
      </header>
      <div className="flex flex-col gap-3 px-4">
        <HomeSearchBar
          query={query}
          onQueryChange={setQuery}
          searchActive={query.length > 0}
          onClear={() => setQuery("")}
          onCancel={() => setQuery("")}
          onFocus={() => undefined}
          onBlur={() => undefined}
          inputRef={inputRef}
          filterButton={
            <FiltersIconButton activeCount={2} open={false} onClick={() => undefined} />
          }
        />
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
function ChromePage({ hidden, initialQuery = "" }: { hidden: boolean; initialQuery?: string }) {
  return (
    <div className="flex h-64 flex-col gap-4 overflow-hidden">
      <ScrollChrome hidden={hidden} testId="fixture-chrome">
        <ChromeContent initialQuery={initialQuery} />
      </ScrollChrome>
      <div className="flex flex-1 items-start justify-center px-4 text-sm text-on-surface-variant">
        <span data-testid="fixture-chrome-feed-body">Feed content starts here</span>
      </div>
    </div>
  );
}

export function ChromeFixtures() {
  return (
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
        <ChromePage hidden={false} />
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
