import { useEffect, useRef, useState } from "react";
import { MapPin, Minus, Plus } from "lucide-react";
import { motion } from "framer-motion";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";
import {
  resolveMapSource,
  type MapSourceOverride,
} from "../services/location/mapSource";
import { configureMapLibreWorker } from "../services/location/maplibreWorker";
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
  /** Tile-source seam (tests / self-hosted / commercial styles). */
  mapSourceOverride?: MapSourceOverride;
}

type MapPhase = "starting" | "ready" | "unsupported" | "error";

interface ReadonlyRasterFallbackProps {
  lat: number;
  lng: number;
  zoom: number;
  /** Truthful status line (WebGL copy or the map error message). */
  notice: string;
  /** Retry is offered for load errors, not for WebGL-less devices. */
  onRetry: (() => void) | null;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

/**
 * Dependency-free fallback map: a plain-<img> 3x3 OSM grid with a center
 * pin and zoom controls. Used when MapLibre cannot start or its tiles fail
 * before load — no WebGL, no new dependencies.
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
        {tiles.map((tile) => (
          <img
            key={`${tile.z}/${tile.x}/${tile.y}`}
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
 * Read-only interactive MapLibre map for a pinned post location.
 *
 * Coordinates render a marker with pan and pinch/button zoom plus
 * attribution. Label-only posts render a neutral fallback: the label is
 * shown, no coordinates are fabricated, and no geocoding is attempted.
 * The external Open in Maps action stays separate in the caller.
 */
export function InteractiveLocationMap({
  lat,
  lng,
  label,
  mapSourceOverride,
}: InteractiveLocationMapProps) {
  const rawCenter = { lat, lng };
  const center = isValidCenter(rawCenter) ? rawCenter : null;
  const centerLat = center?.lat;
  const centerLng = center?.lng;
  const trimmedLabel = label?.trim() || null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<MapLibreMarker | null>(null);

  const [mapSource] = useState(() => resolveMapSource(mapSourceOverride));
  const [retryKey, setRetryKey] = useState(0);
  const [mapPhase, setMapPhase] = useState<MapPhase>("starting");
  const [mapMessage, setMapMessage] = useState<string | null>(null);
  const [tileNotice, setTileNotice] = useState<string | null>(null);
  const [rasterZoom, setRasterZoom] = useState(PIN_ZOOM);

  useEffect(() => {
    if (centerLat == null || centerLng == null) return;
    const mapLat: number = centerLat;
    const mapLng: number = centerLng;
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    let loadTimer = 0;
    setMapPhase("starting");
    setMapMessage(null);
    setTileNotice(null);

    async function init(): Promise<void> {
      let mod: typeof import("maplibre-gl");
      try {
        mod = await import("maplibre-gl");
      } catch {
        if (!cancelled) {
          setMapPhase("error");
          setMapMessage("The map library could not load — check your connection and try again.");
        }
        return;
      }
      if (cancelled) return;
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
        setMapMessage("The map container is missing — try again.");
        return;
      }
      // A 0x0 container (first Android WebView layout) builds a blank canvas
      // that never recovers: wait for layout, then construct and resize. The
      // wait is bounded — worst case we build anyway and the load timeout
      // below degrades to the fallback instead of hanging on "Loading map…".
      await waitForContainerLayout(containerRef.current);
      if (cancelled) return;
      const host = containerRef.current;
      if (host == null) {
        setMapPhase("error");
        setMapMessage("The map container is missing — try again.");
        return;
      }
      let next: MapLibreMap;
      try {
        configureMapLibreWorker(mod);
        next = new mod.Map({
          container: host,
          style: mapSource.styleUrl,
          center: [mapLng, mapLat],
          zoom: PIN_ZOOM,
          attributionControl: false,
        });
      } catch (err) {
        if (!cancelled) {
          if (err instanceof mod.GPUInitializationError) {
            setMapPhase("unsupported");
          } else {
            setMapPhase("error");
            setMapMessage("The map could not start — check your connection and try again.");
          }
        }
        return;
      }
      mapRef.current = next;
      let loaded = false;
      // A stalled style/load must never spin on "Loading map…" forever:
      // degrade to the raster fallback with a notice and a retry.
      loadTimer = window.setTimeout(() => {
        if (cancelled || loaded) return;
        setMapMessage("The map is taking a while to load — showing fallback tiles instead.");
        setMapPhase((prev) => (prev === "starting" ? "error" : prev));
      }, MAP_LOAD_TIMEOUT_MS);
      try {
        const marker = new mod.Marker().setLngLat([mapLng, mapLat]).addTo(next);
        markerRef.current = marker;
      } catch {
        // The map stays usable without the marker element.
      }
      try {
        next.addControl(new mod.NavigationControl({ showCompass: false }), "top-right");
      } catch {
        // Zoom buttons below are the equivalent control; the map works without these.
      }
      next.on("error", () => {
        if (cancelled) return;
        setTileNotice("Map tiles are unavailable — the pin location is still listed above.");
        if (!loaded) {
          // Tiles failed before first load: the GL canvas would stay blank,
          // so fall back to the raster grid (with retry) instead of hanging.
          setMapMessage("Map tiles are unavailable — showing fallback tiles instead.");
          setMapPhase("error");
        }
      });
      if (typeof ResizeObserver !== "undefined" && host) {
        resizeObserver = new ResizeObserver(() => { if (!cancelled) next.resize(); });
        resizeObserver.observe(host);
      }
      next.on("load", () => {
        if (cancelled) return;
        loaded = true;
        window.clearTimeout(loadTimer);
        try {
          next.resize();
        } catch {
          // Resize is best-effort; the loaded map is already usable.
        }
        setMapPhase("ready");
      });
    }

    void init();
    return () => {
      cancelled = true;
      window.clearTimeout(loadTimer);
      resizeObserver?.disconnect();
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [centerLat, centerLng, mapSource.styleUrl, retryKey]);

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
        {mapPhase === "unsupported" ? (
          <ReadonlyRasterFallback
            lat={centerLat}
            lng={centerLng}
            zoom={rasterZoom}
            notice="Interactive map is not available on this device (WebGL unavailable). The pin location is listed below — use Open in Maps for the full map."
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
            onRetry={() => setRetryKey((key) => key + 1)}
            onZoomIn={() => setRasterZoom((zoom) => clampRasterZoom(zoom + 1))}
            onZoomOut={() => setRasterZoom((zoom) => clampRasterZoom(zoom - 1))}
          />
        ) : null}
        {mapPhase === "ready" ? (
          <div className="absolute bottom-2 right-2 flex gap-1">
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => mapRef.current?.zoomIn()}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm border border-outline bg-surface px-2 text-on-surface focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-on-surface"
            >
              <Plus size={16} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => mapRef.current?.zoomOut()}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-m3-sm border border-outline bg-surface px-2 text-on-surface focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-on-surface"
            >
              <Minus size={16} aria-hidden />
            </button>
          </div>
        ) : null}
      </div>
      <p className="px-3 pt-2 text-xs text-on-surface-variant">
        {mapPhase === "unsupported" || mapPhase === "error"
          ? `${RASTER_ATTRIBUTION} · Fallback tiles`
          : `${mapSource.attribution} · ${mapSource.name}`}
      </p>
      {trimmedLabel && (
        <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-on-surface-variant">
          <MapPin size={13} aria-hidden />
          <span className="truncate">{trimmedLabel}</span>
        </div>
      )}
      {tileNotice ? (
        <p role="status" className="px-3 pb-2 text-xs text-on-surface-variant">
          {tileNotice}
        </p>
      ) : null}
    </section>
  );
}
