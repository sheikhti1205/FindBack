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
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MapLibreMap } from "maplibre-gl";
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
  resolveMapSource,
  type MapSourceOverride,
} from "../services/location/mapSource";
import { configureMapLibreWorker } from "../services/location/maplibreWorker";
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
  resolveNominatimConfig,
  searchPlaces,
  type NominatimSearchOverride,
  type PlaceResult,
} from "../services/location/nominatimSearch";
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
  /** Tile-source seam (tests / self-hosted / commercial styles). */
  mapSourceOverride?: MapSourceOverride;
  /** Search-endpoint seam (the future controlled proxy plugs in here). */
  nominatimOverride?: NominatimSearchOverride;
  locationAdapter?: LocationAdapter;
}

type MapPhase = "starting" | "ready" | "unsupported" | "error";

/** Collapses accidental double-taps on the Search button into one request. */
const SUBMIT_DEBOUNCE_MS = 600;

interface PickerRasterFallbackProps {
  center: MapCenter;
  zoom: number;
  /** Truthful status line (WebGL copy or the map error message). */
  notice: string;
  /** Retry is offered for load errors, not for WebGL-less devices. */
  onRetry: (() => void) | null;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onNudge: (dxTiles: number, dyTiles: number) => void;
}

/**
 * Dependency-free fallback map: a plain-<img> 3x3 OSM tile grid under a
 * fixed center pin, with zoom and nudge controls. Used when MapLibre cannot
 * start (WebGL unavailable, library/construct failure). The draft lives
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
 * Fixed DOM center pin: the map moves under the pin and `moveend →
 * getCenter()` feeds the draft coordinates. Nothing is saved until Confirm,
 * which commits through the same approximate-by-default path as
 * LocationPicker (exact only via explicit opt-in). GPS only recenters the
 * preview — it never commits on its own. Manual positioning works offline:
 * the draft lives outside the tile layer, so a failed tile/style load shows
 * a non-blocking notice while Confirm stays usable.
 */
export function MapPickerSheet({
  open,
  onClose,
  value,
  onConfirm,
  initialSearchResult,
  mapSourceOverride,
  nominatimOverride,
  locationAdapter,
}: MapPickerSheetProps) {
  const [defaultAdapter] = useState(createProductionLocationAdapter);
  const adapter = locationAdapter ?? defaultAdapter;
  const fixGeneration = useRef(0);
  useEffect(() => () => { fixGeneration.current += 1; }, []);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const searchThrottlerRef = useRef<NominatimThrottler | null>(null);
  if (searchThrottlerRef.current == null) {
    searchThrottlerRef.current = new NominatimThrottler();
  }
  const lastSubmitRef = useRef(0);

  const [retryKey, setRetryKey] = useState(0);
  const [mapPhase, setMapPhase] = useState<MapPhase>("starting");
  const [mapMessage, setMapMessage] = useState<string | null>(null);
  const [tileNotice, setTileNotice] = useState<string | null>(null);
  // Raster-fallback camera: mirrors the GL camera so the fallback pin starts
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
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [gpsPreview, setGpsPreview] = useState<MapCenter | null>(null);
  // A coarse fix too imprecise to snap to — held for an explicit opt-in.
  const [pendingFix, setPendingFix] = useState<MapCenter | null>(null);
  const [pendingAccuracy, setPendingAccuracy] = useState<number | null>(null);

  const [mapSource] = useState(() => resolveMapSource(mapSourceOverride));
  const [searchConfig] = useState(() => resolveNominatimConfig(nominatimOverride));

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
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
    setMapPhase("starting");
    setMapMessage(null);
    setTileNotice(null);
    setSearchInput("");
    setSearchError(null);
    setResults([]);
    setLocating(false);
    setGeoError(null);
    setPendingFix(null);
    setPendingAccuracy(null);
    setGpsPreview(null);

    async function init(): Promise<void> {
      let mod: typeof import("maplibre-gl");
      try {
        mod = await import("maplibre-gl");
      } catch {
        if (!cancelled) {
          setMapPhase("error");
          setMapMessage(
            "The map library could not load — you can still confirm coordinates or search once you are back online.",
          );
        }
        return;
      }
      if (cancelled) return;
      // v6 removed the old supported() static: WebGL2 is required and the Map
      // constructor throws GPUInitializationError instead. Honor a
      // supported() export when present (older/newer lines), always keep the
      // constructor try/catch as the real gate.
      const legacy = (mod as unknown as { supported?: unknown }).supported;
      if (typeof legacy === "function") {
        let ok = true;
        try {
          ok = (legacy as () => boolean)();
        } catch {
          ok = false;
        }
        if (!ok) {
          setMapPhase("unsupported");
          return;
        }
      }
      if (containerRef.current == null) {
        setMapPhase("error");
        setMapMessage("The map container is missing — close and reopen the picker.");
        return;
      }
      // A 0x0 container (BottomSheet open animation, first Android WebView
      // layout) builds a blank canvas that never recovers: wait for layout,
      // then construct and resize. The wait is bounded — worst case we build
      // anyway and the load timeout below keeps Confirm usable.
      await waitForContainerLayout(containerRef.current);
      if (cancelled) return;
      const host = containerRef.current;
      if (host == null) {
        setMapPhase("error");
        setMapMessage("The map container is missing — close and reopen the picker.");
        return;
      }
      let next: MapLibreMap;
      try {
        configureMapLibreWorker(mod);
        next = new mod.Map({
          container: host,
          style: mapSource.styleUrl,
          center: [initial.center.lng, initial.center.lat],
          zoom: initial.zoom,
          attributionControl: false,
        });
      } catch (err) {
        if (!cancelled) {
          if (err instanceof mod.GPUInitializationError) {
            setMapPhase("unsupported");
          } else {
            setMapPhase("error");
            setMapMessage(
              "The map could not start — you can still search for a place or confirm coordinates.",
            );
          }
        }
        return;
      }
      mapRef.current = next;
      let loaded = false;
      // A stalled style/load must never spin on "Loading map…" forever:
      // degrade to a usable ready-with-notice state so the pin, search, and
      // Confirm stay usable while tiles catch up (or never do, offline).
      loadTimer = window.setTimeout(() => {
        if (cancelled || loaded) return;
        setTileNotice(
          (prev) =>
            prev ??
            "The map is taking a while to load — you can still pan and confirm the pin.",
        );
        setMapPhase((prev) => (prev === "starting" ? "ready" : prev));
        try {
          next.resize();
        } catch {
          // Resize is best-effort; the notice already keeps Confirm usable.
        }
      }, MAP_LOAD_TIMEOUT_MS);
      try {
        next.addControl(new mod.NavigationControl({ showCompass: false }), "top-right");
      } catch {
        // Zoom buttons are a convenience; the picker works without them.
      }
      next.on("moveend", () => {
        if (cancelled) return;
        const center = next.getCenter();
        if (Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
          fixGeneration.current += 1;
          setLocating(false);
          setDraft({ lat: center.lat, lng: center.lng });
        }
      });
      // Tile/style failures must never block a manual pick: the draft lives
      // outside the tile layer, so this notice stays non-blocking. When the
      // style fails before `load`, promote a stuck "starting" sheet to a
      // degraded ready state so the center pin, search, and Confirm stay
      // usable instead of spinning on "Loading map…" forever.
      next.on("error", () => {
        if (!cancelled) {
          setTileNotice(
            "Map tiles are unavailable — you can still pan and confirm the pin.",
          );
          setMapPhase((prev) => (prev === "starting" ? "ready" : prev));
        }
      });
      // Resize after map load and on actual layout changes (including sheet
      // sizing); the observer is disconnected with this map's lifecycle.
      const container = host;
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => { if (!cancelled) next.resize(); });
        resizeObserver.observe(container);
      }
      next.on("load", () => {
        if (cancelled) return;
        loaded = true;
        window.clearTimeout(loadTimer);
        next.resize();
        setMapPhase("ready");
      });
    }

    void init();
    return () => {
      cancelled = true;
      window.clearTimeout(loadTimer);
      resizeObserver?.disconnect();
      fixGeneration.current += 1;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [
    open,
    retryKey,
    value.latitude,
    value.longitude,
    value.label,
    initialSearchResult,
    mapSource.styleUrl,
  ]);

  /**
   * Eased camera recenter on capable devices; an instant jump when the user
   * prefers reduced motion. Without a GL map (raster fallback) the fallback
   * camera moves instead — the draft is updated by the caller either way.
   */
  function recenterCamera(center: MapCenter, zoom: number = PIN_ZOOM): void {
    const map = mapRef.current;
    if (!map) {
      setFallbackCenter(center);
      return;
    }
    try {
      const animated = map as unknown as { easeTo?: (options: object) => void };
      if (!shouldReduceMotion() && typeof animated.easeTo === "function") {
        animated.easeTo({ center: [center.lng, center.lat], zoom, duration: 600 });
        return;
      }
    } catch {
      // Fall through to the instant jump below.
    }
    try {
      map.jumpTo({ center: [center.lng, center.lat], zoom });
    } catch {
      // The camera is a convenience; the draft is already updated.
    }
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
      const places = await searchPlaces(query, {
        config: searchConfig,
        throttler: searchThrottlerRef.current ?? undefined,
      });
      setResults(places);
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

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Choose location"
      description="Pan the map under the pin, or search. Nothing is saved until you confirm."
      height="large"
    >
      <div className="flex flex-col gap-3">
        <div className="relative h-64 w-full overflow-hidden rounded-m3-md border border-outline-variant bg-surface-container">
          {mapPhase === "starting" || mapPhase === "ready" ? (
            <div
              ref={containerRef}
              data-testid="map-picker-map"
              aria-label="Interactive map. Pan to move the pin."
              className="absolute inset-0"
            />
          ) : null}
          {mapPhase === "ready" || (mapPhase === "starting" && tileNotice) ? (
            <motion.div
              data-testid="map-picker-pin"
              aria-hidden
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: motionDurations.instant, ease: motionEasings.out }}
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
            >
              <MapPin size={32} className="text-on-surface drop-shadow" />
            </motion.div>
          ) : null}
          {mapPhase === "starting" && !tileNotice ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-on-surface-variant">Loading map…</p>
            </div>
          ) : null}
          {mapPhase === "unsupported" ? (
            <PickerRasterFallback
              center={fallbackCenter}
              zoom={fallbackZoom}
              notice="Interactive map is not available on this device (WebGL unavailable). You can still type a place, paste coordinates or a Maps link in the report form, or use Find location in Maps — the map preview and external handoff keep working."
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
          {mapPhase === "unsupported" || mapPhase === "error"
            ? `${RASTER_ATTRIBUTION} · Fallback tiles`
            : `${mapSource.attribution} · ${mapSource.name}`}
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
        <p className="text-xs text-on-surface-variant">
          Place results: {searchConfig.attribution}
        </p>
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
                ? "No location yet — pan the map to place the pin."
                : "Pan the map to adjust the pin."}
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
        {tileNotice ? (
          <div
            data-testid="tile-notice"
            className="flex flex-wrap items-center gap-2"
          >
            <p className="text-xs text-on-surface-variant">{tileNotice}</p>
            <Button
              type="button"
              variant="text"
              size="md"
              onClick={() => {
                setTileNotice(null);
                setMapPhase("starting");
                setRetryKey((key) => key + 1);
              }}
            >
              Retry map tiles
            </Button>
          </div>
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
