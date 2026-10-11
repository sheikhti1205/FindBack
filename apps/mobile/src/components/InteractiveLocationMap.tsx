import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { MapPin, Minus, Plus } from "lucide-react";
import { motion } from "framer-motion";
import {
  isNativeMapPickerAvailable,
  openMapViewerNative,
  renderMapSnapshotNative,
  type MapSnapshotInput,
  type MapSnapshotResult,
  type MapViewerInput,
} from "../native/mapLibreMaps";
import {
  MAP_LOAD_TIMEOUT_MS,
  RASTER_ATTRIBUTION,
  clampRasterZoom,
  rasterTilesForCenter,
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
  /**
   * Snapshot seam. `undefined` (default) auto-detects the FindbackMap bridge
   * on-device; `null` forces the keyless raster fallback (web/dev/tests).
   */
  snapshotter?: ((input: MapSnapshotInput) => Promise<MapSnapshotResult>) | null;
  /** Viewer seam (same auto-detect/force-fallback convention). */
  viewer?: ((input: MapViewerInput) => Promise<{ closed: boolean }>) | null;
}

/** Preview bitmap size (native clamps to ≤1024 px per side regardless). */
const SNAPSHOT_WIDTH_PX = 640;
const SNAPSHOT_HEIGHT_PX = 360;

type MapPhase = "starting" | "ready" | "fallback";

interface ReadonlyRasterFallbackProps {
  lat: number;
  lng: number;
  zoom: number;
  notice: string | null;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

/**
 * Dependency-free keyless map: a plain-<img> 3x3 OSM grid with a center pin
 * and zoom controls. The web/dev surface — and the truthful fallback when a
 * native snapshot fails.
 */
function ReadonlyRasterFallback({
  lat,
  lng,
  zoom,
  notice,
  onZoomIn,
  onZoomOut,
}: ReadonlyRasterFallbackProps) {
  const tiles = rasterTilesForCenter({ lat, lng }, zoom);
  return (
    <div
      data-testid="interactive-fallback-map"
      role="region"
      aria-label="Location map. Use the zoom buttons to inspect the pin area."
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
      {notice ? (
        <div className="absolute inset-x-2 top-2 flex items-center gap-2 rounded-m3-sm bg-surface/95 px-2 py-1">
          <p role="status" className="min-w-0 flex-1 text-[11px] text-on-surface-variant">
            {notice}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Read-only post map.
 *
 * On Android the preview is a native MapSnapshotter bitmap (never a live
 * MapView under the WebView); tap opens the native viewer. Everywhere else
 * the keyless raster grid renders. Label-only posts render a neutral card:
 * the label is shown, no coordinates are fabricated, and no geocoding is
 * attempted. Snapshot failure degrades to the raster fallback with an
 * "Open map" action — never an endless spinner. The external Open in Maps
 * action stays separate in the caller.
 */
export function InteractiveLocationMap({
  lat,
  lng,
  label,
  snapshotter,
  viewer,
}: InteractiveLocationMapProps) {
  const rawCenter = { lat, lng };
  const center = isValidCenter(rawCenter) ? rawCenter : null;
  const centerLat = center?.lat;
  const centerLng = center?.lng;
  const trimmedLabel = label?.trim() || null;

  const [resolvedSnapshotter] = useState(
    () => snapshotter !== undefined ? snapshotter : (isNativeMapPickerAvailable() ? renderMapSnapshotNative : null),
  );
  const [resolvedViewer] = useState(
    () => viewer !== undefined ? viewer : (isNativeMapPickerAvailable() ? openMapViewerNative : null),
  );

  const [mapPhase, setMapPhase] = useState<MapPhase>("starting");
  const [snapshotSrc, setSnapshotSrc] = useState<string | null>(null);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const [rasterZoom, setRasterZoom] = useState(PIN_ZOOM);
  const requestSeq = useRef(0);
  useEffect(() => () => { requestSeq.current += 1; }, []);

  useEffect(() => {
    if (centerLat == null || centerLng == null) return;
    if (resolvedSnapshotter == null) {
      setMapPhase("fallback");
      return;
    }
    const seq = ++requestSeq.current;
    let timedOut = false;
    setMapPhase("starting");
    setSnapshotSrc(null);
    setSnapshotFailed(false);
    const timer = window.setTimeout(() => {
      timedOut = true;
      if (requestSeq.current !== seq) return;
      // Bounded stall: a snapshot that never resolves degrades instead of
      // spinning forever.
      setSnapshotFailed(true);
      setMapPhase("fallback");
    }, MAP_LOAD_TIMEOUT_MS);
    void resolvedSnapshotter({
      latitude: centerLat,
      longitude: centerLng,
      zoom: PIN_ZOOM,
      width: SNAPSHOT_WIDTH_PX,
      height: SNAPSHOT_HEIGHT_PX,
    }).then(
      (snapshot) => {
        window.clearTimeout(timer);
        if (timedOut || requestSeq.current !== seq) return;
        if (!snapshot?.uri?.trim()) {
          setSnapshotFailed(true);
          setMapPhase("fallback");
          return;
        }
        setSnapshotSrc(Capacitor.convertFileSrc(snapshot.uri));
        setMapPhase("ready");
      },
      () => {
        window.clearTimeout(timer);
        if (timedOut || requestSeq.current !== seq) return;
        setSnapshotFailed(true);
        setMapPhase("fallback");
      },
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [centerLat, centerLng, resolvedSnapshotter]);

  function openViewer(): void {
    if (resolvedViewer == null || centerLat == null || centerLng == null) return;
    void resolvedViewer({ latitude: centerLat, longitude: centerLng, zoom: PIN_ZOOM, label: trimmedLabel ?? undefined }).catch(() => {
      // The viewer is a convenience; the preview stays put on failure.
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
        {mapPhase === "starting" ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <p role="status" className="text-sm text-on-surface-variant">
              Loading map preview…
            </p>
          </div>
        ) : null}
        {mapPhase === "ready" && snapshotSrc ? (
          <button
            type="button"
            data-testid="interactive-snapshot"
            onClick={openViewer}
            aria-label={trimmedLabel ? `Open map: ${trimmedLabel}` : "Open map"}
            className="absolute inset-0 h-full w-full"
          >
            <img
              src={snapshotSrc}
              alt=""
              draggable={false}
              className="h-full w-full object-cover"
              onError={() => {
                setSnapshotFailed(true);
                setMapPhase("fallback");
              }}
            />
          </button>
        ) : null}
        {mapPhase === "fallback" ? (
          <ReadonlyRasterFallback
            lat={centerLat}
            lng={centerLng}
            zoom={rasterZoom}
            notice={snapshotFailed ? "The map preview failed — showing fallback tiles instead." : null}
            onZoomIn={() => setRasterZoom((zoom) => clampRasterZoom(zoom + 1))}
            onZoomOut={() => setRasterZoom((zoom) => clampRasterZoom(zoom - 1))}
          />
        ) : null}
        {mapPhase === "fallback" && resolvedViewer != null ? (
          <div className="absolute bottom-2 left-2">
            <button
              type="button"
              onClick={openViewer}
              className="inline-flex min-h-[44px] items-center rounded-m3-sm border border-outline bg-surface px-3 text-sm text-on-surface"
            >
              Open map
            </button>
          </div>
        ) : null}
      </div>
      <p className="px-3 pt-2 text-xs text-on-surface-variant">
        {RASTER_ATTRIBUTION}
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
