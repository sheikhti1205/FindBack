import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { PostType } from "@findback/shared";
import { HomeFilterChips, HomeScopeChips } from "./HomeFilterChips";
import { HomeSearchBar } from "./HomeSearchBar";
import { PostList } from "../components/PostList";
import { PullToRefresh, type PullToRefreshHandle } from "../components/PullToRefresh";
import { NewPostsPill } from "../components/NewPostsPill";
import { BottomSheet } from "../components/BottomSheet";
import { MapPickerSheet } from "../components/MapPickerSheet";
import type { LocationValue } from "../components/LocationPicker";
import { useFeed } from "../hooks/useFeed";
import { FeedLoveProvider } from "../hooks/useFeedLove";
import { useUrlParam } from "../hooks/useUrlParam";
import { onRealtime } from "../services/realtime";
import {
  FIX_MICROCOPY,
  createProductionLocationAdapter,
  requestFixWithGeneration,
} from "../services/locationAdapter";
import {
  DEFAULT_NEARBY_RADIUS_KM,
  NEARBY_RADIUS_OPTIONS_KM,
  NEARBY_SHEET_NOTICE,
  clearNearbySession,
  getNearbySession,
  kmToMeters,
  parseNearbyRadiusParam,
  recentCutoffDate,
  roundNearbyCenter,
  setNearbySession,
  type NearbyCenter,
  type NearbyRadiusKm,
} from "../services/nearby";
import { useAuth } from "../auth";
import { useTabTap } from "../components/TabTap";
import { buildFeedCacheKey, clearNewPostCount, getNewPostCount, incrementNewPostCount } from "../hooks/feedCache";
import { AdvancedSearchFilters, FiltersIconButton, getActiveFilterCount, useAdvancedSearchFilters } from "./AdvancedSearchFilters";
import type { FeedFilters } from "../services/posts";
import {
  fadeVariants,
  motionDurations,
  motionEasings,
  shouldReduceMotion,
} from "../components/uiMotion";

type TypeFilter = PostType | "ALL";

const HOME_CACHE_KEY = "home:feed";

export function Home() {
  const { user } = useAuth();
  const { tapCount } = useTabTap();
  // Imperative travel (scroll-to-top) cannot see MotionConfig — collapse to
  // instant when the OS prefers reduced motion. Read live (not the cached
  // framer-motion singleton) so the value is exact at render/scroll time.
  const reduceMotion = shouldReduceMotion();
  // Type + search survive in the URL so back-nav, deep-links, and copied
  // links restore the feed the reader was looking at.
  const [typeParam, setTypeParam] = useUrlParam("type");
  const type: TypeFilter = typeParam === "LOST" || typeParam === "FOUND" ? typeParam : "ALL";
  const setType = (next: TypeFilter) => setTypeParam(next === "ALL" ? "" : next);
  const [qParam, setQParam] = useUrlParam("q");
  const [query, setQuery] = useState(qParam);
  const [appliedQuery, setAppliedQuery] = useState(qParam.trim());
  // Search activation: the field rests as a compact affordance and expands
  // into its active state on focus/input; clear/cancel collapse it back.
  const [searchFocused, setSearchFocused] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchActive = searchFocused || query.length > 0;
  // Toolbar separation: a subtle border/shadow once the feed scrolls.
  const [toolbarSeparated, setToolbarSeparated] = useState(false);
  const toolbarSeparatedRef = useRef(false);
  const advanced = useAdvancedSearchFilters();
  // Combinable scope row (UXN-1): Nearby | Open | Recent combine freely with
  // the exclusive All/Lost/Found type above. Only the radius travels in the
  // URL (`near=<km>`); the search center stays in private in-memory session
  // state and is never requested until the user taps Nearby.
  const [nearParam, setNearParam] = useUrlParam("near");
  const [recentParam, setRecentParam] = useUrlParam("recent");
  const recentOn = recentParam === "1";
  const [nearbyCenter, setNearbyCenter] = useState<NearbyCenter | null>(
    () => getNearbySession().center,
  );
  const [nearbyActive, setNearbyActive] = useState(
    () => getNearbySession().active && getNearbySession().center !== null,
  );
  const [nearbyRadiusKm, setNearbyRadiusKm] = useState<NearbyRadiusKm>(() => {
    const session = getNearbySession();
    return parseNearbyRadiusParam(nearParam) ?? session.radiusKm;
  });
  const [locating, setLocating] = useState(false);
  const [snack, setSnack] = useState<{ message: string; action?: "map" } | null>(null);
  const [nearbySheetOpen, setNearbySheetOpen] = useState(false);
  const [mapPickerOpen, setMapPickerOpen] = useState(false);

  // Account switch/logout drops the private session center so the next
  // account starts with Nearby off and must tap to grant location again.
  const userId = user?.id;
  const prevUserIdRef = useRef(userId);
  useEffect(() => {
    if (prevUserIdRef.current === userId) return;
    prevUserIdRef.current = userId;
    clearNearbySession();
    setNearbyCenter(null);
    setNearbyActive(false);
    setNearbyRadiusKm(DEFAULT_NEARBY_RADIUS_KM);
    setNearParam("");
    setNearbySheetOpen(false);
    setMapPickerOpen(false);
    setSnack(null);
  }, [userId, setNearParam]);

  function activateNearby(center: NearbyCenter, radiusKm: NearbyRadiusKm) {
    setNearbySession({ center, radiusKm, active: true });
    setNearbyCenter(center);
    setNearbyRadiusKm(radiusKm);
    setNearbyActive(true);
    setNearParam(String(radiusKm));
    setSnack(null);
    setMapPickerOpen(false);
    setNearbySheetOpen(false);
  }

  async function enableNearby() {
    if (locating) return;
    // A cached session center reactivates without re-prompting; a fresh
    // activation always goes through the one-time coarse location request.
    const cached = getNearbySession();
    if (cached.center && !nearbyActive) {
      activateNearby(cached.center, parseNearbyRadiusParam(nearParam) ?? cached.radiusKm);
      return;
    }
    setLocating(true);
    try {
      const state = await requestFixWithGeneration(createProductionLocationAdapter());
      if (state.kind === "fix") {
        activateNearby(
          roundNearbyCenter(state.lat, state.lng),
          parseNearbyRadiusParam(nearParam) ?? DEFAULT_NEARBY_RADIUS_KM,
        );
      } else if (state.kind === "denied") {
        setSnack({ message: FIX_MICROCOPY.denied, action: "map" });
      } else if (state.kind === "services-off") {
        setSnack({ message: FIX_MICROCOPY["services-off"], action: "map" });
      } else if (
        state.kind === "timeout" ||
        state.kind === "unavailable" ||
        state.kind === "unsupported"
      ) {
        setSnack({ message: state.message, action: "map" });
      }
      // Intermediate (requesting-permission/locating) and stale-generation
      // (idle) states never surface here — nothing to show.
    } finally {
      setLocating(false);
    }
  }

  function disableNearby() {
    setNearbySession({ active: false });
    setNearbyActive(false);
    setNearParam("");
    setNearbySheetOpen(false);
  }

  function onNearbyTap() {
    if (nearbyActive) setNearbySheetOpen(true);
    else void enableNearby();
  }

  /** Quick Open maps to status OPEN, replacing an advanced status selection. */
  const openActive = advanced.status === "OPEN";
  function onOpenTap() {
    if (advanced.status === "OPEN") advanced.setStatus("");
    else advanced.setStatus("OPEN");
  }

  function onRecentTap() {
    setRecentParam(recentOn ? "" : "1");
  }

  function onRadiusChange(next: NearbyRadiusKm) {
    setNearbyRadiusKm(next);
    setNearbySession({ radiusKm: next });
    setNearParam(String(next));
  }

  /** Manual "Choose area on map" fallback: only a real map pin can activate. */
  function onMapConfirm(value: LocationValue) {
    if (typeof value.latitude === "number" && typeof value.longitude === "number") {
      activateNearby(
        roundNearbyCenter(value.latitude, value.longitude),
        parseNearbyRadiusParam(nearParam) ?? nearbyRadiusKm,
      );
    } else {
      setMapPickerOpen(false);
      setSnack({
        message: "Nearby needs a map pin — typed place names alone are not included.",
        action: "map",
      });
    }
  }

  const mapPickerValue: LocationValue = {
    label: "",
    latitude: nearbyCenter?.lat ?? null,
    longitude: nearbyCenter?.lng ?? null,
    precision: "APPROXIMATE",
  };

  const feedFilters: FeedFilters = {
    type: type === "ALL" ? "" : type,
    q: appliedQuery || undefined,
    category: advanced.category || undefined,
    status: advanced.status || undefined,
    sort: advanced.sort,
    dateFrom: recentOn ? recentCutoffDate() : undefined,
    ...(nearbyActive && nearbyCenter
      ? {
          nearLat: nearbyCenter.lat,
          nearLng: nearbyCenter.lng,
          radiusM: kmToMeters(nearbyRadiusKm),
        }
      : {}),
  };
  const scopedCacheKey = buildFeedCacheKey(HOME_CACHE_KEY, feedFilters);
  const [newPostCount, setNewPostCount] = useState(() => getNewPostCount(scopedCacheKey));
  const [hasUpdates, setHasUpdates] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const scrollRef = useRef<PullToRefreshHandle>(null);

  // Debounce the search box so each keystroke does not hit the API.
  useEffect(() => {
    const t = setTimeout(() => setAppliedQuery(query.trim()), 400);
    return () => clearTimeout(t);
  }, [query]);

  // Publish the applied query to the URL once it settles.
  useEffect(() => {
    setQParam(appliedQuery);
  }, [appliedQuery, setQParam]);

  const { items, total, loading, refreshing, loadingMore, error, hasMore, refresh, loadMore, removeItem, patchItem } = useFeed(
    feedFilters,
    { cacheKey: HOME_CACHE_KEY, scrollRef },
  );

  // Active Home tab tap: refresh + scroll top. Smooth normally, instant
  // under reduced motion. Scroll restore after Post Detail comes from the
  // useFeed session cache (items + scrollTop survive unmount); mounting here
  // never replays card entrances — no list animation is owned by this file.
  useEffect(() => {
    if (tapCount === 0) return;
    void refresh();
    scrollRef.current?.scrollToTop(reduceMotion ? "auto" : "smooth");
    setNewPostCount(0);
    setHasUpdates(false);
    clearNewPostCount(scopedCacheKey);
  }, [tapCount, refresh, scopedCacheKey, reduceMotion]);

  // Live: only new inserts increment new-posts; else show Updates. Never yank scroll.
  useEffect(() => {
    const off = onRealtime("feed:changed", (payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      const change =
        typeof p.change === "string"
          ? p.change.toUpperCase()
          : typeof p.op === "string"
            ? p.op.toUpperCase()
            : typeof p.type === "string"
              ? p.type.toUpperCase()
              : null;
      // Only a genuine INSERT is a new post. Comment/reaction/rating triggers
      // broadcast feed:changed with a non-INSERT change kind.
      const isInsert = change === "INSERT" || p.isNew === true;
      const scrolled = (scrollRef.current?.scrollTop ?? 0) > 40;
      // Nearby scope: the broadcast cannot prove whether an inserted post
      // lies inside the radius, so never claim "N new posts" — refresh at
      // the top, generic Updates while scrolled.
      if (nearbyActive) {
        if (!scrolled) void refresh();
        else setHasUpdates(true);
        return;
      }
      if (!isInsert) {
        if (!scrolled) void refresh();
        else setHasUpdates(true);
        return;
      }

      // Prove filter membership from the broadcast metadata. A provable
      // non-member (e.g. FOUND while filtered to LOST) is ignored — it can
      // never appear in this view, so it must not raise a pill. When an active
      // search query makes membership unprovable, show generic Updates.
      const postType = typeof p.postType === "string" ? p.postType.toUpperCase() : null;
      const typeOk = type === "ALL" || postType === type;
      const canProveNonMember = postType !== null && !typeOk;
      if (canProveNonMember) return;

      const matchesFilter = typeOk && !appliedQuery && !advanced.category && !advanced.status;
      if (scrolled) {
        if (matchesFilter) {
          incrementNewPostCount(scopedCacheKey, 1);
          setNewPostCount(getNewPostCount(scopedCacheKey));
        } else {
          setHasUpdates(true);
        }
      } else {
        void refresh();
      }
    });
    return off;
  }, [refresh, scopedCacheKey, type, appliedQuery, advanced.category, advanced.status, nearbyActive]);

  // A post was deleted: reconcile it in place. Never refetch here — a full
  // refresh would rerender/reorder the list underneath a scrolled reader.
  useEffect(() => {
    const off = onRealtime("post:deleted", (payload) => {
      const postId = (payload as { postId?: unknown })?.postId;
      if (typeof postId === "string") removeItem(postId);
    });
    return off;
  }, [removeItem]);

  useEffect(() => {
    setNewPostCount(getNewPostCount(scopedCacheKey));
    setHasUpdates(false);
  }, [scopedCacheKey]);

  function onNewPostsTap() {
    void refresh();
    scrollRef.current?.scrollToTop(reduceMotion ? "auto" : "smooth");
    setNewPostCount(0);
    setHasUpdates(false);
    clearNewPostCount(scopedCacheKey);
  }

  // Scroll events from the PullToRefresh container do not bubble, but React
  // listens in the capture phase — one guarded setState per crossing, never
  // per pixel, so the toolbar toggle cannot rerender the feed on scroll.
  function handleFeedScroll(e: SyntheticEvent) {
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
    <div className="flex h-full flex-col gap-4" onScrollCapture={handleFeedScroll}>
      <header
        data-testid="home-toolbar"
        style={{ transitionDuration: reduceMotion ? "0s" : `${motionDurations.fast}s` }}
        className={`border-b px-4 pt-5 transition-[border-color,box-shadow] ${
          toolbarSeparated ? "border-outline-variant shadow-sm" : "border-transparent shadow-none"
        }`}
      >
        <h1 className="text-xl font-semibold tracking-tight">FindBack</h1>
        <AnimatePresence initial={false} mode="wait">
          <motion.p
            key={total}
            variants={fadeVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
            className="text-xs text-on-surface-variant"
          >
            {total} item{total === 1 ? "" : "s"} · signed in as @{user?.username}
          </motion.p>
        </AnimatePresence>
      </header>

      <div className="flex flex-col gap-3 px-4">
        <HomeSearchBar
          query={query}
          onQueryChange={setQuery}
          searchActive={searchActive}
          onClear={() => setQuery("")}
          onCancel={collapseSearch}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          inputRef={searchInputRef}
          filterButton={
            <FiltersIconButton
              activeCount={getActiveFilterCount(advanced)}
              open={filtersOpen}
              onClick={() => setFiltersOpen(true)}
            />
          }
        />
        <div className="fb-scroll-fade">
          <div className="fb-scroll-row flex items-center gap-3" aria-label="Feed filters">
            <HomeFilterChips value={type} onChange={setType} />
            <span aria-hidden className="h-6 shrink-0 border-l border-outline-variant" />
            <HomeScopeChips
              nearbyActive={nearbyActive}
              nearbyRadiusKm={nearbyRadiusKm}
              locating={locating}
              openActive={openActive}
              recentActive={recentOn}
              onNearbyTap={onNearbyTap}
              onOpenTap={onOpenTap}
              onRecentTap={onRecentTap}
            />
          </div>
        </div>
        {snack && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-m3-sm bg-surface-container px-4 py-3 text-sm text-on-surface"
          >
            <p className="flex-1">{snack.message}</p>
            {snack.action === "map" && (
              <button
                type="button"
                onClick={() => setMapPickerOpen(true)}
                className="min-h-[44px] shrink-0 rounded-full px-3 text-sm font-medium underline"
              >
                Choose area on map
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setSnack(null)}
              className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full"
            >
              ✕
            </button>
          </div>
        )}
        <AdvancedSearchFilters
          filters={advanced}
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
          hideTrigger
        />
        <BottomSheet
          open={nearbySheetOpen}
          onClose={() => setNearbySheetOpen(false)}
          title="Nearby"
          description="Search radius around your area."
          height="medium"
        >
          <div className="flex flex-col gap-3 pb-2">
            <p className="text-sm text-on-surface-variant">{NEARBY_SHEET_NOTICE}</p>
            <div role="radiogroup" aria-label="Radius" className="flex flex-wrap gap-2">
              {NEARBY_RADIUS_OPTIONS_KM.map((km) => (
                <button
                  key={km}
                  type="button"
                  role="radio"
                  aria-checked={km === nearbyRadiusKm}
                  onClick={() => onRadiusChange(km)}
                  className={`min-h-[44px] rounded-full border px-4 text-sm font-medium ${
                    km === nearbyRadiusKm
                      ? "border-transparent bg-on-surface text-surface"
                      : "border-outline-variant text-on-surface-variant"
                  }`}
                >
                  {km} km
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setNearbySheetOpen(false);
                setMapPickerOpen(true);
              }}
              className="inline-flex min-h-[48px] items-center justify-center rounded-m3-sm border border-outline-variant px-4 text-sm font-medium"
            >
              Choose area on map
            </button>
            <button
              type="button"
              onClick={disableNearby}
              className="inline-flex min-h-[48px] items-center justify-center rounded-m3-sm px-4 text-sm font-medium underline"
            >
              Turn off Nearby
            </button>
          </div>
        </BottomSheet>
        <MapPickerSheet
          open={mapPickerOpen}
          onClose={() => setMapPickerOpen(false)}
          value={mapPickerValue}
          onConfirm={onMapConfirm}
        />
      </div>

      <NewPostsPill count={newPostCount} hasUpdates={hasUpdates} onTap={onNewPostsTap} />

      <PullToRefresh ref={scrollRef} onRefresh={refresh} disabled={loading || refreshing} className="flex-1">
        {/* UXN-2: batch-hydrated Love state + optimistic feed-cache patching.
            PostList itself is untouched — the provider flows state to each
            home-feed card's Love toggle via context. */}
        <FeedLoveProvider items={items} patchItem={patchItem}>
          <PostList
            items={items}
            loading={loading}
            refreshing={refreshing}
            loadingMore={loadingMore}
            error={error}
            hasMore={hasMore}
            onLoadMore={loadMore}
            onRetry={refresh}
            density="home-feed"
            emptyTitle={appliedQuery || advanced.category || advanced.status || nearbyActive ? "No matches" : "Nothing here yet"}
            emptySubtitle={
              nearbyActive
                ? "Try a wider radius or different filters. Nearby uses reports with a map pin."
                : advanced.category || advanced.status
                  ? "Try different filters or a broader search."
                  : appliedQuery
                    ? `No posts match “${appliedQuery}”.`
                    : "Tap Create report to post a lost or found item."
            }
          />
        </FeedLoveProvider>
      </PullToRefresh>
    </div>
  );
}
