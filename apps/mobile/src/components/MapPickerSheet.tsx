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
  isNativeMapPickerAvailable,
  openMapPickerNative,
  type MapPickerInput,
  type MapPickerResult,
} from "../native/mapLibreMaps";
import {
  RASTER_ATTRIBUTION,
  clampRasterZoom,
  nudgeCenter,
  rasterTilesForCenter,
} from "../services/location/rasterTiles";
import {
  NominatimRateLimitError,
  sharedNominatimThrottler,
  type NominatimSearchOverride,
  type PlaceResult,
} from "../services/location/nominatimSearch";
import {
  attributionForSource,
  searchPlacesUnified,
} from "../services/location/placesSearch";
import { recordOperation } from "../services/monitoring/operations";
import {
  PIN_ZOOM,
  commitCenterAsLocation,
  formatCoordinateReadout,
  isValidCenter,
  resolveInitialView,
  type InitialViewSource,
  type MapCenter,
} from "../services/location/mapPickerState";
import { motionDurations, motionEasings } from "./uiMotion";

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
  /** Search-endpoint seam for Nominatim (the future controlled proxy plugs in here). */
  nominatimOverride?: NominatimSearchOverride;
  /**
   * Native picker seam. `undefined` (default) auto-detects the FindbackMap
   * bridge on-device; `null` forces the keyless fallback (web/dev/tests).
   */
  nativePicker?: ((options: MapPickerInput) => Promise<MapPickerResult>) | null;
  locationAdapter?: LocationAdapter;
}

/** Collapses accidental double-taps on the Search button into one request. */
const SUBMIT_DEBOUNCE_MS = 600;

interface PickerRasterMapProps {
  center: MapCenter;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onNudge: (dxTiles: number, dyTiles: number) => void;
}

/**
 * Dependency-free keyless map: a plain-<img> 3x3 OSM tile grid under a fixed
 * center pin, with zoom and nudge controls. The draft lives outside the tile
 * layer, so search, GPS preview, nudge, and Confirm all keep working —
 * including offline, where the grid simply shows no tiles.
 */
function PickerRasterMap({ center, zoom, onZoomIn, onZoomOut, onNudge }: PickerRasterMapProps) {
  const tiles = rasterTilesForCenter(center, zoom);
  return (
    <div
      data-testid="map-picker-map"
      role="region"
      aria-label="Map. Use the move and zoom buttons to position the pin."
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
    </div>
  );
}

/**
 * Interactive location picker.
 *
 * On Android the native MapLibre picker owns the interaction: this component
 * renders nothing and forwards Confirm/Cancel from the Activity. Confirm
 * commits through the same approximate-by-default path as LocationPicker
 * (exact opt-in stays in LocationPicker's own toggle, exactly like the GPS,
 * manual, and link entry paths). Cancel never mutates the draft.
 *
 * On web/dev (or when the bridge is missing) a keyless fallback sheet
 * applies: raster tiles under a fixed center pin, explicit-submit Nominatim
 * search, one-shot GPS preview, and manual nudge. Nothing is saved until
 * Confirm in either path.
 */
export function MapPickerSheet({
  open,
  onClose,
  value,
  onConfirm,
  initialSearchResult,
  nominatimOverride,
  nativePicker,
  locationAdapter,
}: MapPickerSheetProps) {
  const [defaultAdapter] = useState(createProductionLocationAdapter);
  const adapter = locationAdapter ?? defaultAdapter;
  const fixGeneration = useRef(0);
  useEffect(() => () => { fixGeneration.current += 1; }, []);
  // Process-wide throttle (MAP-3): the shared provider-level gate, so
  // reopening the sheet cannot mint a fresh limiter. Explicit-submit only.
  const searchThrottlerRef = useRef(sharedNominatimThrottler);
  const lastSubmitRef = useRef(0);

  // `undefined` auto-detects the on-device bridge; an explicit `null` (or a
  // test double) overrides it. useState keeps the resolution stable per mount
  // so a mid-flight bridge change cannot double-launch the picker.
  const [resolvedPicker] = useState(
    () => nativePicker !== undefined ? nativePicker : (isNativeMapPickerAvailable() ? openMapPickerNative : null),
  );
  // A rejected native picker falls back in place (stays open): the raster
  // map + search + current-location + manual confirm remain usable below a
  // truthful notice. The draft/value survives the transition.
  const [nativeUnavailable, setNativeUnavailable] = useState(false);
  const nativeActive = open && resolvedPicker != null && !nativeUnavailable;

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

  // Native path: forward to the Activity; Cancel closes with no mutation.
  // `launchedRef` makes the launch once-per-open: a mid-flight value change
  // must not fire a second Activity (which would reject BUSY and spuriously
  // close the sheet while the first Activity still owns the interaction).
  // `launchStateRef` freezes the launch inputs: the in-flight result is
  // honored with the open-time value/label/callbacks, so a mid-flight change
  // can neither relaunch nor orphan the pending Activity result. (Reading
  // props through a ref keeps this effect subscribed only to open/picker.)
  const launchedRef = useRef(false);
  const launchStateRef = useRef({ value, initialSearchResult, onConfirm, onClose });
  launchStateRef.current = { value, initialSearchResult, onConfirm, onClose };
  useEffect(() => {
    if (!open) {
      launchedRef.current = false;
      setNativeUnavailable(false);
    }
  }, [open]);
  useEffect(() => {
    if (!open || resolvedPicker == null || launchedRef.current) return;
    launchedRef.current = true;
    let stale = false;
    const {
      value: launchValue,
      initialSearchResult: launchSearch,
      onConfirm: confirm,
      onClose: close,
    } = launchStateRef.current;
    const reportPin =
      launchValue.latitude != null && launchValue.longitude != null
        ? { lat: launchValue.latitude, lng: launchValue.longitude }
        : null;
    const searchStart =
      launchSearch != null
        ? { lat: launchSearch.lat, lng: launchSearch.lng }
        : null;
    const initial = resolveInitialView({
      reportPin: isValidCenter(reportPin) ? reportPin : null,
      searchResult: isValidCenter(searchStart) ? searchStart : null,
      gpsPreview: null,
    });
    const label =
      launchSearch?.label.trim() || launchValue.label.trim() || "Pinned location";
    // Neutral-world start sends NO camera seed: the native side shows its
    // display-only default with a null draft (Confirm disabled) instead of a
    // fabricated pin at (0,0) — which would pass validation and look real.
    // The seed zoom is omitted too so a world-zoom value cannot override the
    // native neutral framing.
    const seed =
      initial.source === "neutral-world"
        ? {}
        : { latitude: initial.center.lat, longitude: initial.center.lng, zoom: initial.zoom };
    void resolvedPicker({ ...seed, label }).then(
      (result) => {
        if (stale) return;
        if (!result.cancelled) {
          // Approximate-by-default, identical to every other entry path;
          // exact opt-in lives in LocationPicker's toggle.
          confirm(
            commitCenterAsLocation(
              label,
              { lat: result.latitude, lng: result.longitude },
              "APPROXIMATE",
            ),
          );
          announce("Approximate location selected (~100 m).");
        }
        close();
      },
      () => {
        if (stale) return;
        // Native rejection (MAP_UNAVAILABLE / launch failure) stays open:
        // seed the in-place raster/manual fallback from the open-time
        // value so the draft survives, then show the truthful notice.
        // Cancel still closes with no mutation via the fallback sheet.
        setViewSource(initial.source);
        setDraft(initial.source === "neutral-world" ? null : initial.center);
        setFallbackCenter(initial.center);
        setFallbackZoom(initial.zoom);
        setDraftLabel(label);
        setExact(false);
        setSearchInput("");
        setSearchError(null);
        setResults([]);
        setLocating(false);
        setGeoError(null);
        setPendingFix(null);
        setPendingAccuracy(null);
        setGpsPreview(null);
        setNativeUnavailable(true);
      },
    );
    return () => {
      stale = true;
    };
  }, [open, resolvedPicker]);

  // Fallback path: reset the sheet draft whenever it opens.
  useEffect(() => {
    if (!open || resolvedPicker != null) return;
    const reportPin =
      value.latitude != null && value.longitude != null
        ? { lat: value.latitude, lng: value.longitude }
        : null;
    const searchStart =
      initialSearchResult != null
        ? { lat: initialSearchResult.lat, lng: initialSearchResult.lng }
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
    setLocating(false);
    setGeoError(null);
    setPendingFix(null);
    setPendingAccuracy(null);
    setGpsPreview(null);
  }, [open, resolvedPicker, value.latitude, value.longitude, value.label, initialSearchResult]);

  /** Moves the fallback camera (the draft is updated by the caller). */
  function recenterCamera(center: MapCenter): void {
    setFallbackCenter(center);
  }

  /** Nudge-pad pan (also the offline manual path). */
  function nudgeFallback(dxTiles: number, dyTiles: number): void {
    const nextCenter = nudgeCenter(fallbackCenter, fallbackZoom, dxTiles, dyTiles);
    fixGeneration.current += 1;
    setLocating(false);
    setFallbackCenter(nextCenter);
    setDraft(nextCenter);
  }

  /** Snaps the preview to a fix. Never confirms — the user still confirms. */
  function snapPreviewTo(fix: MapCenter): void {
    setGpsPreview(fix);
    setPendingFix(null);
    setPendingAccuracy(null);
    setDraft(fix);
    setFallbackCenter(fix);
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
      // Nominatim explicit-submit ONLY (no keystroke autocomplete, per the
      // search-usage policy).
      const { places } = await searchPlacesUnified(query, {
        nominatimOverride,
        throttler: searchThrottlerRef.current ?? undefined,
        now,
      });
      setResults(places);
      // Seam: result-class + source only — never the query or coordinates.
      recordOperation({
        name: "map.search",
        fields: {
          resultClass: places.length === 0 ? "zero" : places.length <= 3 ? "few" : "many",
          rateLimited: false,
          source: "unified",
        },
      });
      if (places.length === 0) {
        setSearchError("No places found — pan the map and confirm the pin instead.");
      }
    } catch (err) {
      if (err instanceof NominatimRateLimitError) {
        // Seam: rate-limit flag only — never the query or coordinates.
        recordOperation({
          name: "map.search",
          fields: { resultClass: "zero", rateLimited: true, source: "unified" },
        });
        setSearchError("Please wait a moment and try the search again.");
      } else {
        // Seam: failure class only — never the query, coordinates, or message.
        recordOperation({
          name: "map.search",
          fields: { resultClass: "zero", rateLimited: false, source: "unified" },
        });
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

  // The native Activity owns the whole interaction — render nothing.
  if (nativeActive) return null;

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
      description="Use search or the move buttons to place the pin, or use your location. Nothing is saved until you confirm."
      height="large"
    >
      <div className="flex flex-col gap-3">
        {nativeUnavailable ? (
          <p role="alert" className="text-sm text-on-surface">
            Map view isn&apos;t available right now. You can still choose the location below.
          </p>
        ) : null}
        <div className="relative h-64 w-full overflow-hidden rounded-m3-md border border-outline-variant bg-surface-container">
          <PickerRasterMap
            center={fallbackCenter}
            zoom={fallbackZoom}
            onZoomIn={() => setFallbackZoom((zoom) => clampRasterZoom(zoom + 1))}
            onZoomOut={() => setFallbackZoom((zoom) => clampRasterZoom(zoom - 1))}
            onNudge={nudgeFallback}
          />
        </div>
        <p className="text-xs text-on-surface-variant">{RASTER_ATTRIBUTION}</p>

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
        {results.length > 0 ? (
          <p className="text-xs text-on-surface-variant">
            Place results: {attributionForSource()}
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
                ? "No location yet — search or move the pin to place it."
                : "Use search or the move buttons to adjust the pin."}
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
