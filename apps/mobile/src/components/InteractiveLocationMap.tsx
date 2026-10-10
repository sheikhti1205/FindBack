import { useEffect, useRef, useState } from "react";
import { MapPin, Minus, Plus } from "lucide-react";
import { motion } from "framer-motion";
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
  rasterTilesForCenter,
  waitForContainerLayout,
} from "../services/location/rasterTiles";
import { motionDurations, motionEasings } from "./uiMotion";
import {
  PIN_ZOOM,
  isValidCenter,
} from "../services/location/mapPickerState";

interface InteractiveLocationMapProps {
  lat?: number | null;
  lng?: number | null;
  label?: string | null;
  /** Maps-key seam (tests force configured/unconfigured without env). */
  mapsConfigOverride?: GoogleMapsConfig;
  /** Map-transport seam (tests drive a fake handle; production uses the real plugin). */
  mapLoader?: NativeMapLoader;
}

type MapPhase = "starting" | "ready" | "unavailable" | "error";

/** Native-map attribution (the SDK also draws its own logo/attribution). */
const GOOGLE_ATTRIBUTION = "© Google";

/** Consumer copy for the fail-closed missing-key state (never dev jargon). */
const MAP_UNAVAILABLE_MESSAGE =
  "The interactive map isn't available right now — the pin location is listed below.";

/** Google zoom range guard for the overlay zoom buttons. */
const MIN_NATIVE_ZOOM = 2;
const MAX_NATIVE_ZOOM = 20;

function clampNativeZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return PIN_ZOOM;
  return Math.min(MAX_NATIVE_ZOOM, Math.max(MIN_NATIVE_ZOOM, Math.round(zoom)));
}

interface ReadonlyRasterFallbackProps {
  lat: number;
  lng: number;
  zoom: number;
  /** Truthful status line (unavailable copy or the map error message). */
  notice: string;
  /** Retry is offered for load errors, not for the missing-key state. */
  onRetry: (() => void) | null;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

/**
 * Dependency-free fallback map: a plain-<img> 3x3 OSM grid with a center
 * pin and zoom controls. Used when the native map cannot start — no key, no
 * new dependencies.
 */
function ReadonlyRasterFallback({
  lat,
  lng,
  zoom,
  notice,
  onRetry,
  onZoomIn,
  onZoomOut,
}: ReadonlyRasterFallbackProps) {
  const tiles = rasterTilesForCenter({ lat, lng }, zoom);
  return (
    <div
      data-testid="interactive-fallback-map"
      role="region"
      aria-label="Fallback location map. Use the zoom buttons to inspect the pin area."
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
          <MapPin size={24} className="text-on-surface drop-shadow" />
        </motion.div>
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
 * Read-only native Google map for a pinned post location.
 *
 * Coordinates render a fixed marker with pan and pinch/button zoom plus
 * attribution. Label-only posts render a neutral fallback: the label is
 * shown, no coordinates are fabricated, and no geocoding is attempted.
 * The external Open in Maps action stays separate in the caller.
 */
export function InteractiveLocationMap({
  lat,
  lng,
  label,
  mapsConfigOverride,
  mapLoader,
}: InteractiveLocationMapProps) {
  const rawCenter = { lat, lng };
  const center = isValidCenter(rawCenter) ? rawCenter : null;
  const centerLat = center?.lat;
  const centerLng = center?.lng;
  const trimmedLabel = label?.trim() || null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<NativeMapHandle | null>(null);

  const [mapsConfig] = useState(() => mapsConfigOverride ?? resolveGoogleMapsConfig());
  const [retryKey, setRetryKey] = useState(0);
  const [mapPhase, setMapPhase] = useState<MapPhase>("starting");
  const [mapMessage, setMapMessage] = useState<string | null>(null);
  const [rasterZoom, setRasterZoom] = useState(PIN_ZOOM);
  const [nativeZoom, setNativeZoom] = useState(PIN_ZOOM);

  useEffect(() => {
    if (centerLat == null || centerLng == null) return;
    const mapLat: number = centerLat;
    const mapLng: number = centerLng;
    let cancelled = false;
    let loadTimer = 0;
    setMapPhase("starting");
    setMapMessage(null);
    setNativeZoom(PIN_ZOOM);

    if (!isGoogleMapsConfigured(mapsConfig)) {
      setMapPhase("unavailable");
      setMapMessage(MAP_UNAVAILABLE_MESSAGE);
      return () => {
        cancelled = true;
      };
    }

    async function init(): Promise<void> {
      const host = containerRef.current;
      if (host == null) {
        if (!cancelled) {
          setMapPhase("error");
          setMapMessage("The map container is missing — try again.");
        }
        return;
      }
      // A 0x0 container (first Android WebView layout) misplaces the native
      // view: wait for layout first. The wait is bounded — worst case we
      // build anyway and the stall timer below degrades to the fallback
      // instead of hanging on "Loading map…".
      await waitForContainerLayout(host);
      if (cancelled) return;
      if (containerRef.current == null) {
        if (!cancelled) {
          setMapPhase("error");
          setMapMessage("The map container is missing — try again.");
        }
        return;
      }
      // A stalled native view must never spin on "Loading map…" forever:
      // degrade to the raster fallback with a notice and a retry.
      let timedOut = false;
      loadTimer = window.setTimeout(() => {
        timedOut = true;
        if (cancelled) return;
        setMapMessage("The map is taking a while to load — showing fallback tiles instead.");
        setMapPhase("error");
      }, MAP_LOAD_TIMEOUT_MS);
      let next: NativeMapHandle;
      try {
        next = await createNativeMap(host, {
          apiKey: mapsConfig.apiKey,
          center: { lat: mapLat, lng: mapLng },
          zoom: PIN_ZOOM,
          draggable: false,
          loader: mapLoader,
        });
        await next.setMarker({ lat: mapLat, lng: mapLng });
      } catch {
        if (!cancelled) {
          window.clearTimeout(loadTimer);
          setMapPhase("error");
          setMapMessage("The map could not start — check your connection and try again.");
        }
        return;
      }
      if (cancelled || timedOut) {
        window.clearTimeout(loadTimer);
        try {
          await next.destroy();
        } catch {
          // Teardown is best-effort; the view is already gone or degraded.
        }
        return;
      }
      window.clearTimeout(loadTimer);
      mapRef.current = next;
      if (!cancelled) setMapPhase("ready");
    }

    void init();
    return () => {
      cancelled = true;
      window.clearTimeout(loadTimer);
      const handle = mapRef.current;
      mapRef.current = null;
      if (handle) {
        void handle.destroy().catch(() => {
          // Teardown is best-effort; the view is already gone.
        });
      }
    };
  }, [centerLat, centerLng, mapsConfig, mapLoader, retryKey]);

  /**
   * Retry mounts the map container FIRST (phase "starting") in the same
   * commit as the rebuild: the effect's init reads a mounted host instead of
   * the unmounted error-phase tree. Bumping the key alone would re-run the
   * effect against the still-unmounted container and fail with
   * "container missing".
   */
  function retryMap(): void {
    setMapPhase("starting");
    setMapMessage(null);
    setRetryKey((key) => key + 1);
  }

  function zoomNative(delta: number): void {
    const handle = mapRef.current;
    const nextZoom = clampNativeZoom(nativeZoom + delta);
    setNativeZoom(nextZoom);
    if (!handle) return;
    void handle.setCamera({ lat: centerLat as number, lng: centerLng as number }, nextZoom, true).catch(() => {
      // Zoom buttons are a convenience; gestures still work.
    });
  }

  const regionLabel = trimmedLabel ? `Location map: ${trimmedLabel}` : "Location map";

  if (centerLat == null || centerLng == null) {
    return (
      <div className="overflow-hidden rounded-m3-md border border-outline-variant">
        <div
          role="status"
          className="flex min-h-48 flex-col items-center justify-center gap-2 bg-surface-container px-6 py-8 text-center"
        >
          <MapPin size={20} className="text-on-surface-variant" aria-hidden />
          {trimmedLabel && <p className="text-sm font-medium text-on-surface">{trimmedLabel}</p>}
          <p className="text-sm text-on-surface-variant">
            Interactive map needs coordinates — without coordinates the place name above is all
            that was shared.
          </p>
        </div>
      </div>
    );
  }

  return (
    <section
      aria-label={regionLabel}
      className="overflow-hidden rounded-m3-md border border-outline-variant"
    >
      <div className="relative h-48 w-full bg-surface-container">
        {mapPhase === "starting" || mapPhase === "ready" ? (
          <div
            ref={containerRef}
            data-testid="interactive-location-map"
            role="region"
            aria-label="Interactive location map. Drag to pan, pinch or use zoom controls."
            className="absolute inset-0"
          />
        ) : null}
        {mapPhase === "starting" ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <p role="status" className="text-sm text-on-surface-variant">
              Loading map…
            </p>
          </div>
        ) : null}
        {mapPhase === "unavailable" ? (
          <ReadonlyRasterFallback
            lat={centerLat}
            lng={centerLng}
            zoom={rasterZoom}
            notice={mapMessage ?? MAP_UNAVAILABLE_MESSAGE}
            onRetry={null}
            onZoomIn={() => setRasterZoom((zoom) => clampRasterZoom(zoom + 1))}
            onZoomOut={() => setRasterZoom((zoom) => clampRasterZoom(zoom - 1))}
          />
        ) : null}
        {mapPhase === "error" ? (
          <ReadonlyRasterFallback
            lat={centerLat}
            lng={centerLng}
            zoom={rasterZoom}
            notice={mapMessage ?? "The map could not start — check your connection and try again."}
            onRetry={retryMap}
            onZoomIn={() => setRasterZoom((zoom) => clampRasterZoom(zoom + 1))}
            onZoomOut={() => setRasterZoom((zoom) => clampRasterZoom(zoom - 1))}
          />
        ) : null}
        {mapPhase === "ready" ? (
          <div className="absolute bottom-2 right-2 flex gap-1">
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => zoomNative(1)}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm border border-outline bg-surface px-2 text-on-surface focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-on-surface"
            >
              <Plus size={16} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => zoomNative(-1)}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm border border-outline bg-surface px-2 text-on-surface focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-on-surface"
            >
              <Minus size={16} aria-hidden />
            </button>
          </div>
        ) : null}
      </div>
      <p className="px-3 pt-2 text-xs text-on-surface-variant">
        {mapPhase === "unavailable" || mapPhase === "error"
          ? `${RASTER_ATTRIBUTION} · Fallback tiles`
          : GOOGLE_ATTRIBUTION}
      </p>
      {trimmedLabel && (
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-on-surface-variant">
          <MapPin size={13} aria-hidden />
          <span className="truncate">{trimmedLabel}</span>
        </div>
      )}
    </section>
  );
}
