import { useEffect, useRef, useState, type FormEvent } from "react";
import { Crosshair, MapPin } from "lucide-react";
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
      let next: MapLibreMap;
      try {
        next = new mod.Map({
          container: containerRef.current,
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
      // outside the tile layer, so this notice stays non-blocking.
      next.on("error", () => {
        if (!cancelled) {
          setTileNotice(
            "Map tiles are unavailable — you can still pan and confirm the pin.",
          );
        }
      });
      if (!cancelled) setMapPhase("ready");
    }

    void init();
    return () => {
      cancelled = true;
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

  /** Snaps the preview to a fix. Never confirms — the user still confirms. */
  function snapPreviewTo(fix: MapCenter): void {
    setGpsPreview(fix);
    setPendingFix(null);
    setPendingAccuracy(null);
    setDraft(fix);
    mapRef.current?.jumpTo({ center: [fix.lng, fix.lat], zoom: PIN_ZOOM });
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

  async function handleSearchSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
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
    mapRef.current?.jumpTo({ center: [center.lng, center.lat], zoom: PIN_ZOOM });
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
          {mapPhase === "ready" ? (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
            >
              <MapPin size={32} className="text-on-surface drop-shadow" />
            </div>
          ) : null}
          {mapPhase === "starting" ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-on-surface-variant">Loading map…</p>
            </div>
          ) : null}
          {mapPhase === "unsupported" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <MapPin size={20} className="text-on-surface-variant" aria-hidden />
              <p className="text-sm text-on-surface-variant">
                Interactive map is not available on this device (WebGL
                unavailable). You can still type a place, paste coordinates or
                a Maps link in the report form, or use Find location in Maps —
                the map preview and external handoff keep working.
              </p>
            </div>
          ) : null}
          {mapPhase === "error" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <MapPin size={20} className="text-on-surface-variant" aria-hidden />
              <p className="text-sm text-on-surface-variant">{mapMessage}</p>
              <Button
                type="button"
                variant="outline"
                size="md"
                onClick={() => {
                  setMapPhase("starting");
                  setMapMessage(null);
                  setRetryKey((key) => key + 1);
                }}
              >
                Try again
              </Button>
            </div>
          ) : null}
        </div>
        <p className="text-xs text-on-surface-variant">
          {mapSource.attribution} · {mapSource.name}
        </p>

        <form onSubmit={(event) => void handleSearchSubmit(event)} className="flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Search for a place</span>
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search for a place"
              aria-label="Search for a place"
              maxLength={120}
              className="w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none"
            />
          </label>
          <Button type="submit" variant="outline" size="md" loading={searching}>
            Search
          </Button>
        </form>
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
          <p className="text-xs text-on-surface-variant">{tileNotice}</p>
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
