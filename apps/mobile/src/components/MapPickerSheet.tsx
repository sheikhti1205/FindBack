import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Crosshair,
  MapPin,
  Minus,
  Plus,
} from "lucide-react";
import { motion } from "framer-motion";
import { BottomSheet } from "./BottomSheet";
import { Button } from "./Button";
import { announce } from "./LiveRegion";
import type { LocationValue } from "./LocationPicker";
import {
  formatAccuracy,
  isLowAccuracy,
  locationFailureMessage,
} from "./locationPermission";
import {
  createProductionLocationAdapter,
  requestFixWithGeneration,
  type LocationAdapter,
} from "../services/locationAdapter";
import {
  isGoogleMapsConfigured,
  resolveGoogleMapsConfig,
  type GoogleMapsConfig,
} from "../services/location/googleMapsConfig";
import {
  createNativeMap,
  type NativeMapHandle,
  type NativeMapLoader,
} from "../services/location/nativeMap";
import {
  MAP_LOAD_TIMEOUT_MS,
  RASTER_ATTRIBUTION,
  clampRasterZoom,
  nudgeCenter,
  rasterTilesForCenter,
  waitForContainerLayout,
} from "../services/location/rasterTiles";
import {
  NominatimRateLimitError,
  NominatimThrottler,
  type NominatimSearchOverride,
  type PlaceResult,
} from "../services/location/nominatimSearch";
import {
  attributionForSource,
  searchPlacesUnified,
  type PlacesSearchSource,
} from "../services/location/placesSearch";
import {
  PIN_ZOOM,
  commitCenterAsLocation,
  formatCoordinateReadout,
  isValidCenter,
  resolveInitialView,
  type InitialViewSource,
  type MapCenter,
} from "../services/location/mapPickerState";
import { motionDurations, motionEasings, shouldReduceMotion } from "./uiMotion";

export interface MapPickerSearchResult {
  lat: number;
  lng: number;
  label: string;
}

export interface MapPickerSheetProps {
  open: boolean;
  onClose: () => void;
  /** Existing report pin — start-order #1 (camera only until Confirm). */
  value: LocationValue;
  onConfirm: (next: LocationValue) => void;
  /** Chosen search result from a previous session — start-order #2. */
  initialSearchResult?: MapPickerSearchResult | null;
  /** Search-endpoint seam for the Nominatim fallback (the future controlled proxy plugs in here). */
  nominatimOverride?: NominatimSearchOverride;
  /** Maps-key seam (tests force configured/unconfigured without env). */
  mapsConfigOverride?: GoogleMapsConfig;
  /** Map-transport seam (tests drive a fake handle; production uses the real plugin). */
  mapLoader?: NativeMapLoader;
  /** Native Places transport seam (tests; production uses the real bridge). */
  nativeSearch?: (query: string) => Promise<PlaceResult[]>;
  locationAdapter?: LocationAdapter;
}

type MapPhase = "starting" | "ready" | "unavailable" | "error";

/** Collapses accidental double-taps on the Search button into one request. */
const SUBMIT_DEBOUNCE_MS = 600;

/** Native-map attribution (the SDK also draws its own logo/attribution). */
const GOOGLE_ATTRIBUTION = "© Google";

/** Consumer copy for the fail-closed missing-key state (never dev jargon). */
const MAP_UNAVAILABLE_MESSAGE =
  "The interactive map isn't available right now — you can still search for a place, use the buttons below to position the pin, and confirm.";

interface PickerRasterFallbackProps {
  center: MapCenter;
  zoom: number;
  /** Truthful status line (unavailable copy or the map error message). */
  notice: string;
  /** Retry is offered for load errors, not for the missing-key state. */
  onRetry: (() => void) | null;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onNudge: (dxTiles: number, dyTiles: number) => void;
}

/**
 * Dependency-free fallback map: a plain-<img> 3x3 OSM tile grid under a
 * fixed center pin, with zoom and nudge controls. Used when the native Google
 * map cannot start (no API key, construct failure, offline). The draft lives
 * outside the tile layer, so search, GPS preview, nudge, and Confirm all keep
 * working — including offline, where the grid simply shows no tiles.
 */
function PickerRasterFallback({
  center,
  zoom,
  notice,
  onRetry,
  onZoomIn,
  onZoomOut,
  onNudge,
}: PickerRasterFallbackProps) {
  const tiles = rasterTilesForCenter(center, zoom);
  return (
    <div
      data-testid="map-picker-fallback"
      role="region"
      aria-label="Fallback map. Use the move and zoom buttons to position the pin."
      className="absolute inset-0"
    >
      <div className="absolute inset-0 grid grid-cols-3 grid-rows-3" aria-hidden="true">
        {tiles.map((tile, index) => (
          <img
            // Grid position disambiguates: at minimum zoom the 3x3 window
            // wraps/clamps into repeated z/x/y coordinates, so tile
            // coordinates alone are NOT unique React keys (duplicate keys
            // corrupt reconciliation). Repeated tile URLs are fine; repeated
            // identities are not.
            key={`${tile.z}/${tile.x}/${tile.y}#${index}`}
            src={tile.url}
            alt=""
            draggable={false}
            loading="lazy"
            className="h-full w-full object-cover"
            // A failed tile (offline/blocked) hides itself instead of showing
            // a broken-image glyph over the pin area.
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <motion.div
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: motionDurations.instant, ease: motionEasings.out }}
        >
          <MapPin size={32} className="text-on-surface drop-shadow" />
        </motion.div>
      </div>
      <div
        role="group"
        aria-label="Move pin"
        className="absolute bottom-2 left-2 grid grid-cols-3 gap-0.5"
      >
        <span />
        <button
          type="button"
          aria-label="Move pin north"
          onClick={() => onNudge(0, -1)}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm border border-outline bg-surface text-on-surface"
        >
          <ChevronUp size={16} aria-hidden />
        </button>
        <span />
        <button
          type="button"
          aria-label="Move pin west"
          onClick={() => onNudge(-1, 0)}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm border border-outline bg-surface text-on-surface"
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Move pin south"
          onClick={() => onNudge(0, 1)}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm border border-outline bg-surface text-on-surface"
        >
          <ChevronDown size={16} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Move pin east"
          onClick={() => onNudge(1, 0)}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm border border-outline bg-surface text-on-surface"
        >
          <ChevronRight size={16} aria-hidden />
        </button>
      </div>
      <div className="absolute bottom-2 right-2 flex gap-1">
        <button
          type="button"
          aria-label="Zoom in"
          onClick={onZoomIn}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm border border-outline bg-surface px-2 text-on-surface"
        >
          <Plus size={16} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={onZoomOut}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm border border-outline bg-surface px-2 text-on-surface"
        >
          <Minus size={16} aria-hidden />
        </button>
      </div>
      <div className="absolute inset-x-2 top-2 flex items-center gap-2 rounded-m3-sm bg-surface/95 px-2 py-1">
        <p role="status" className="min-w-0 flex-1 text-[11px] text-on-surface-variant">
          {notice}
        </p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded-m3-sm px-2 py-2 text-[11px] font-medium text-on-surface underline"
          >
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Interactive location picker in a bottom sheet.
 *
 * Native Google map with one draggable marker: tapping the map or dragging
 * the marker moves the draft; panning the camera alone never does (the marker
 * is the pin — there is no pan-under-pin coupling to misread). Nothing is
 * saved until Confirm, which commits through the same approximate-by-default
 * path as LocationPicker (exact only via explicit opt-in). GPS only recenters
 * the preview — it never commits on its own. Manual positioning works
 * offline: the draft lives outside the tile layer, so a failed map load shows
 * a non-blocking notice while Confirm stays usable. Without a Maps API key
 * the sheet fails closed to the raster fallback with consumer copy.
 */
export function MapPickerSheet({
  open,
  onClose,
  value,
  onConfirm,
  initialSearchResult,
  nominatimOverride,
  mapsConfigOverride,
  mapLoader,
  nativeSearch,
  locationAdapter,
}: MapPickerSheetProps) {
  const [defaultAdapter] = useState(createProductionLocationAdapter);
  const adapter = locationAdapter ?? defaultAdapter;
  const fixGeneration = useRef(0);
  useEffect(() => () => { fixGeneration.current += 1; }, []);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<NativeMapHandle | null>(null);
  const searchThrottlerRef = useRef<NominatimThrottler | null>(null);
  if (searchThrottlerRef.current == null) {
    searchThrottlerRef.current = new NominatimThrottler();
  }
  const lastSubmitRef = useRef(0);

  const [retryKey, setRetryKey] = useState(0);
  const [mapPhase, setMapPhase] = useState<MapPhase>("starting");
  const [mapMessage, setMapMessage] = useState<string | null>(null);
  // Raster-fallback camera: mirrors the native camera so the fallback pin starts
  // where the map would have, and search/GPS/nudge keep it in sync.
  const [fallbackCenter, setFallbackCenter] = useState<MapCenter>({ lat: 0, lng: 0 });
  const [fallbackZoom, setFallbackZoom] = useState(PIN_ZOOM);
  const [viewSource, setViewSource] = useState<InitialViewSource>("neutral-world");
  const [draft, setDraft] = useState<MapCenter | null>(null);
  const [draftLabel, setDraftLabel] = useState("Pinned location");
  const [exact, setExact] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [searchSource, setSearchSource] = useState<PlacesSearchSource>("nominatim");
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [gpsPreview, setGpsPreview] = useState<MapCenter | null>(null);
  // A coarse fix too imprecise to snap to — held for an explicit opt-in.
  const [pendingFix, setPendingFix] = useState<MapCenter | null>(null);
  const [pendingAccuracy, setPendingAccuracy] = useState<number | null>(null);

  const [mapsConfig] = useState(() => mapsConfigOverride ?? resolveGoogleMapsConfig());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let loadTimer = 0;

    const reportPin =
      value.latitude != null && value.longitude != null
        ? { lat: value.latitude, lng: value.longitude }
        : null;
    const searchStart =
      initialSearchResult != null
        ? {
            lat: initialSearchResult.lat,
            lng: initialSearchResult.lng,
          }
        : null;
    const initial = resolveInitialView({
      reportPin: isValidCenter(reportPin) ? reportPin : null,
      searchResult: isValidCenter(searchStart) ? searchStart : null,
      gpsPreview: null,
    });

    setViewSource(initial.source);
    setDraft(initial.source === "neutral-world" ? null : initial.center);
    setFallbackCenter(initial.center);
    setFallbackZoom(initial.zoom);
    setDraftLabel(
      initialSearchResult?.label.trim() || value.label.trim() || "Pinned location",
    );
    setExact(false);
    setSearchInput("");
    setSearchError(null);
    setResults([]);
    setSearchSource("nominatim");
    setLocating(false);
    setGeoError(null);
    setPendingFix(null);
    setPendingAccuracy(null);
    setGpsPreview(null);

    if (!isGoogleMapsConfigured(mapsConfig)) {
      setMapPhase("unavailable");
      setMapMessage(MAP_UNAVAILABLE_MESSAGE);
      return () => {
        cancelled = true;
        fixGeneration.current += 1;
      };
    }
    setMapPhase("starting");
    setMapMessage(null);

    async function init(): Promise<void> {
      const host = containerRef.current;
      if (host == null) {
        if (!cancelled) {
          setMapPhase("error");
          setMapMessage("The map container is missing — close and reopen the picker.");
        }
        return;
      }
      // A 0x0 container (BottomSheet open animation, first Android WebView
      // layout) misplaces the native view: wait for layout first. The wait is
      // bounded — worst case we build anyway and the stall timer below keeps
      // Confirm usable.
      await waitForContainerLayout(host);
      if (cancelled) return;
      if (containerRef.current == null) {
        if (!cancelled) {
          setMapPhase("error");
          setMapMessage("The map container is missing — close and reopen the picker.");
        }
        return;
      }
      // A stalled native view must never spin on "Loading map…" forever:
      // degrade to a usable error-with-retry state so search, GPS, and
      // Confirm stay usable. A late-resolving create is destroyed on arrival.
      let timedOut = false;
      loadTimer = window.setTimeout(() => {
        timedOut = true;
        if (cancelled) return;
        setMapMessage(
          "The map is taking a while to load — you can still search for a place or confirm coordinates.",
        );
        setMapPhase("error");
      }, MAP_LOAD_TIMEOUT_MS);
      let next: NativeMapHandle;
      try {
        next = await createNativeMap(host, {
          apiKey: mapsConfig.apiKey,
          center: initial.center,
          zoom: initial.zoom,
          draggable: true,
          loader: mapLoader,
        });
      } catch {
        if (!cancelled) {
          window.clearTimeout(loadTimer);
          setMapPhase("error");
          setMapMessage(
            "The map could not start — you can still search for a place or confirm coordinates.",
          );
        }
        return;
      }
      if (cancelled || timedOut) {
        window.clearTimeout(loadTimer);
        try {
          await next.destroy();
        } catch {
          // Teardown is best-effort; the sheet is already gone or degraded.
        }
        return;
      }
      window.clearTimeout(loadTimer);
      mapRef.current = next;
      try {
        if (initial.source !== "neutral-world") {
          await next.setMarker(initial.center);
        }
        await next.onMapTap((pick) => {
          if (cancelled || !isValidCenter(pick.center)) return;
          // Tap places the marker AND the draft (the camera does not move).
          void next.setMarker(pick.center).catch(() => {
            // Marker sync is a convenience; the draft below is the source of
            // truth and still commits.
          });
          fixGeneration.current += 1;
          setLocating(false);
          setDraft(pick.center);
          setFallbackCenter(pick.center);
        });
        await next.onMarkerDragEnd((pick) => {
          if (cancelled || !isValidCenter(pick.center)) return;
          // The native marker already sits at the drop point — draft only.
          fixGeneration.current += 1;
          setLocating(false);
          setDraft(pick.center);
          setFallbackCenter(pick.center);
        });
      } catch {
        if (!cancelled) {
          setMapPhase("error");
          setMapMessage(
            "The map could not start — you can still search for a place or confirm coordinates.",
          );
        }
        return;
      }
      if (!cancelled) setMapPhase("ready");
    }

    void init();
    return () => {
      cancelled = true;
      window.clearTimeout(loadTimer);
      fixGeneration.current += 1;
      const handle = mapRef.current;
      mapRef.current = null;
      if (handle) {
        // Native-view teardown: the map must not survive the closed sheet
        // (leaked views overlay later screens and later reopens).
        void handle.destroy().catch(() => {
          // Teardown is best-effort; the sheet is already gone.
        });
      }
    };
  }, [
    open,
    retryKey,
    value.latitude,
    value.longitude,
    value.label,
    initialSearchResult,
    mapsConfig,
    mapLoader,
  ]);

  /**
   * Eased camera recenter; an instant jump when the user prefers reduced
   * motion. Without a native map (fallback phases) the fallback camera moves
   * instead — the draft is updated by the caller either way.
   */
  function recenterCamera(center: MapCenter, zoom: number = PIN_ZOOM): void {
    const map = mapRef.current;
    if (!map) {
      setFallbackCenter(center);
      return;
    }
    void map.setCamera(center, zoom, !shouldReduceMotion()).catch(() => {
      // The camera is a convenience; the draft is already updated.
    });
  }

  /** Moves the native marker to the draft (GPS/search/nudge paths). */
  function syncMarker(center: MapCenter): void {
    const map = mapRef.current;
    if (!map) return;
    void map.setMarker(center).catch(() => {
      // Marker sync is a convenience; the draft is the source of truth.
    });
  }

  /** Nudge-pad pan for the raster fallback (also the offline manual path). */
  function nudgeFallback(dxTiles: number, dyTiles: number): void {
    const nextCenter = nudgeCenter(fallbackCenter, fallbackZoom, dxTiles, dyTiles);
    fixGeneration.current += 1;
    setLocating(false);
    setFallbackCenter(nextCenter);
    setDraft(nextCenter);
  }

  function retryMap(): void {
    setMapPhase("starting");
    setMapMessage(null);
    setRetryKey((key) => key + 1);
  }

  /** Snaps the preview to a fix. Never confirms — the user still confirms. */
  function snapPreviewTo(fix: MapCenter): void {
    setGpsPreview(fix);
    setPendingFix(null);
    setPendingAccuracy(null);
    setDraft(fix);
    setFallbackCenter(fix);
    syncMarker(fix);
    recenterCamera(fix);
    announce("Preview recentered on your location. Confirm to use it.");
  }

  /**
   * Explicit, one-shot, coarse request. Concurrent taps collapse into one
   * platform prompt; a fix coarser than the ~100 m pin is held for opt-in.
   */
  function useCurrentLocation(): void {
    setLocating(true);
    setGeoError(null);
    setPendingFix(null);
    setPendingAccuracy(null);
    void requestFixWithGeneration(adapter, { generation: fixGeneration }).then((outcome) => {
      if (outcome.kind === "idle") return;
      setLocating(false);
      if (outcome.kind !== "fix") {
        if (outcome.kind !== "locating" && outcome.kind !== "requesting-permission") {
          setGeoError(locationFailureMessage(outcome.kind === "services-off" ? "disabled" : outcome.kind));
        }
        return;
      }
      const fix: MapCenter = { lat: outcome.lat, lng: outcome.lng };
      if (isLowAccuracy(outcome.accuracy)) {
        setPendingFix(fix);
        setPendingAccuracy(outcome.accuracy);
        return;
      }
      snapPreviewTo(fix);
    });
  }

  function acceptPendingFix(): void {
    if (!pendingFix) return;
    snapPreviewTo(pendingFix);
  }

  async function handleSearchSubmit(event?: FormEvent): Promise<void> {
    // No nested <form> exists anymore (see below), but stop propagation
    // defensively: this sheet renders inside the Report <form>, and a submit
    // event reaching it would publish the report.
    event?.preventDefault();
    event?.stopPropagation();
    const now = Date.now();
    if (now - lastSubmitRef.current < SUBMIT_DEBOUNCE_MS) return;
    lastSubmitRef.current = now;
    const query = searchInput.trim();
    if (!query || searching) return;
    setSearching(true);
    setSearchError(null);
    try {
      // Native Places first, Nominatim fallback — submit-only either way
      // (no keystroke autocomplete, per the search-usage policy).
      const { places, source } = await searchPlacesUnified(query, {
        nominatimOverride,
        throttler: searchThrottlerRef.current ?? undefined,
        nativeSearch,
        now,
      });
      setResults(places);
      setSearchSource(source);
      if (places.length === 0) {
        setSearchError("No places found — pan the map and confirm the pin instead.");
      }
    } catch (err) {
      if (err instanceof NominatimRateLimitError) {
        setSearchError("Please wait a moment and try the search again.");
      } else {
        setSearchError(
          err instanceof Error
            ? err.message
            : "Place search failed — pan the map and confirm the pin instead.",
        );
      }
    } finally {
      setSearching(false);
    }
  }

  function pickResult(place: PlaceResult): void {
    fixGeneration.current += 1;
    setLocating(false);
    const center: MapCenter = { lat: place.latitude, lng: place.longitude };
    setDraft(center);
    setDraftLabel(place.displayName);
    setFallbackCenter(center);
    syncMarker(center);
    recenterCamera(center);
  }

  function handleConfirm(): void {
    if (!draft) return;
    const label = draftLabel.trim() || "Pinned location";
    onConfirm(
      commitCenterAsLocation(label, draft, exact ? "EXACT" : "APPROXIMATE"),
    );
    announce(
      exact ? "Exact pin selected." : "Approximate location selected (~100 m).",
    );
    onClose();
  }

  const pending = draft
    ? commitCenterAsLocation(
        draftLabel.trim() || "Pinned location",
        draft,
        exact ? "EXACT" : "APPROXIMATE",
      )
    : null;
  const readout = pending ? formatCoordinateReadout(pending) : null;
  const searchAttribution =
    results.length > 0
      ? searchSource === "places"
        ? attributionForSource("places")
        : attributionForSource("nominatim")
      : null;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Choose location"
      description="Drag the marker or tap the map to place the pin, or search. Nothing is saved until you confirm."
      height="large"
    >
      <div className="flex flex-col gap-3">
        <div className="relative h-64 w-full overflow-hidden rounded-m3-md border border-outline-variant bg-surface-container">
          {mapPhase === "starting" || mapPhase === "ready" ? (
            <div
              ref={containerRef}
              data-testid="map-picker-map"
              aria-label="Interactive map. Drag the marker or tap to place the pin."
              className="absolute inset-0"
            />
          ) : null}
          {mapPhase === "starting" ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-on-surface-variant">Loading map…</p>
            </div>
          ) : null}
          {mapPhase === "unavailable" ? (
            <PickerRasterFallback
              center={fallbackCenter}
              zoom={fallbackZoom}
              notice={mapMessage ?? MAP_UNAVAILABLE_MESSAGE}
              onRetry={null}
              onZoomIn={() => setFallbackZoom((zoom) => clampRasterZoom(zoom + 1))}
              onZoomOut={() => setFallbackZoom((zoom) => clampRasterZoom(zoom - 1))}
              onNudge={nudgeFallback}
            />
          ) : null}
          {mapPhase === "error" ? (
            <PickerRasterFallback
              center={fallbackCenter}
              zoom={fallbackZoom}
              notice={
                mapMessage ??
                "The map could not start — you can still search for a place or confirm coordinates."
              }
              onRetry={retryMap}
              onZoomIn={() => setFallbackZoom((zoom) => clampRasterZoom(zoom + 1))}
              onZoomOut={() => setFallbackZoom((zoom) => clampRasterZoom(zoom - 1))}
              onNudge={nudgeFallback}
            />
          ) : null}
        </div>
        <p className="text-xs text-on-surface-variant">
          {mapPhase === "unavailable" || mapPhase === "error"
            ? `${RASTER_ATTRIBUTION} · Fallback tiles`
            : GOOGLE_ATTRIBUTION}
        </p>

        {/* Deliberately NOT a <form>: this sheet renders inside the Report
          <form> (BottomSheet mounts in the component tree, not a portal), and
          an inner submit would propagate to it and could publish the report.
          Enter searches via the input key handler instead. */}
        <div className="flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Search for a place</span>
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleSearchSubmit(event);
              }}
              placeholder="Search for a place"
              aria-label="Search for a place"
              maxLength={120}
              className="w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
            />
          </label>
          <Button type="button" variant="outline" size="md" loading={searching} onClick={() => void handleSearchSubmit()}>
            Search
          </Button>
        </div>
        {searchAttribution ? (
          <p className="text-xs text-on-surface-variant">
            Place results: {searchAttribution}
          </p>
        ) : null}
        {searchError ? (
          <p role="alert" className="text-xs text-error">
            {searchError}
          </p>
        ) : null}
        {results.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {results.map((place) => (
              <li key={`${place.latitude},${place.longitude}`}>
                <button
                  type="button"
                  onClick={() => pickResult(place)}
                  className="w-full rounded-m3-sm px-3 py-3 text-left text-sm text-on-surface hover:bg-surface-container"
                >
                  <span className="block truncate">{place.displayName}</span>
                  <span className="block text-xs text-on-surface-variant">
                    {place.latitude.toFixed(5)}, {place.longitude.toFixed(5)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="md"
            loading={locating}
            onClick={useCurrentLocation}
          >
            <Crosshair size={16} aria-hidden />
            Use my location once
          </Button>
          {readout ? (
            <span className="flex items-center gap-1 text-xs text-on-surface-variant">
              <MapPin size={13} aria-hidden />
              {readout}
            </span>
          ) : (
            <span className="text-xs text-on-surface-variant">
              {viewSource === "neutral-world"
                ? "No location yet — tap the map to place the pin."
                : "Drag the marker or tap the map to adjust the pin."}
            </span>
          )}
        </div>
        {pendingFix ? (
          <div
            data-testid="low-accuracy-notice"
            className="flex flex-wrap items-center gap-2 rounded-m3-sm border border-outline-variant bg-surface-container px-3 py-2"
          >
            <p className="text-xs text-on-surface-variant">
              This location is only accurate to about{" "}
              {pendingAccuracy != null ? formatAccuracy(pendingAccuracy) : "a few km"}.
              Nothing was saved — confirm if you still want to use it.
            </p>
            <Button type="button" variant="outline" size="md" onClick={acceptPendingFix}>
              Use this location anyway
            </Button>
          </div>
        ) : null}
        {geoError ? <p className="text-xs text-error">{geoError}</p> : null}
        {gpsPreview ? (
          <p className="text-xs text-on-surface-variant">
            Preview centered on your location — confirm to use it. Your location
            is never saved on its own.
          </p>
        ) : null}

        {draft && exact ? (
          <div className="flex flex-wrap items-center gap-2 rounded-m3-sm border border-error px-3 py-2">
            <p className="text-xs text-error">
              Warning: this is an exact pin and will be shown publicly. Prefer
              the approximate area.
            </p>
            <Button
              type="button"
              variant="outline"
              size="md"
              onClick={() => setExact(false)}
            >
              Round to ~100 m
            </Button>
          </div>
        ) : null}
        {draft && !exact ? (
          <div className="flex flex-wrap items-center gap-2 rounded-m3-sm bg-surface-container px-3 py-2">
            <p className="text-xs text-on-surface-variant">
              Pin rounded to ~100 m precision.
            </p>
            <Button type="button" variant="text" size="md" onClick={() => setExact(true)}>
              Use exact pin
            </Button>
          </div>
        ) : null}

        <Button
          type="button"
          variant="primary"
          size="lg"
          disabled={!draft}
          onClick={handleConfirm}
        >
          Confirm location
        </Button>
      </div>
    </BottomSheet>
  );
}
