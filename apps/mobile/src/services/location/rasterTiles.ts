/**
 * Dependency-free raster tile fallback for the native Google maps.
 *
 * The native Google map stays the primary renderer. When it cannot
 * start (no API key, construct failure, offline) the picker and the
 * read-only location map fall back to a plain-<img> 3x3 OSM tile grid
 * computed from center/zoom — no new dependencies, no WebGL, no canvas.
 * The draft/confirm path never depends on either renderer: coordinates live
 * outside the tile layer, so Confirm stays usable offline in every phase.
 */

/** Pixels per raster tile edge (OSM standard). */
export const RASTER_TILE_SIZE_PX = 256;
/** Widest useful fallback zoom (whole world fits the 3x3 grid). */
export const RASTER_MIN_ZOOM = 1;
/** Deepest OSM zoom served everywhere. */
export const RASTER_MAX_ZOOM = 19;
/**
 * Budget a stuck style/load waits before degrading to a usable
 * ready-with-notice state instead of "Loading map…" forever (~8s).
 */
export const MAP_LOAD_TIMEOUT_MS = 8000;
/** Fallback attribution for the raster grid (replaces the GL source line). */
export const RASTER_ATTRIBUTION = "© OpenStreetMap contributors";

const MERCATOR_MAX_LAT = 85.05112878;

export interface RasterCenter {
  lat: number;
  lng: number;
}

export interface RasterTile {
  x: number;
  y: number;
  z: number;
  url: string;
}

/** Round into the OSM zoom range; non-finite input falls back to minimum. */
export function clampRasterZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return RASTER_MIN_ZOOM;
  return Math.min(RASTER_MAX_ZOOM, Math.max(RASTER_MIN_ZOOM, Math.round(zoom)));
}

/** OSM raster URL for one tile — plain https, no SDK. */
export function rasterTileUrl(x: number, y: number, z: number): string {
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

function wrapLng(lng: number): number {
  const wrapped = ((lng + 180) % 360 + 360) % 360;
  return wrapped - 180;
}

function clampLat(lat: number): number {
  return Math.min(MERCATOR_MAX_LAT, Math.max(-MERCATOR_MAX_LAT, lat));
}

/** Slippy-map xyz for a lon/lat at a zoom (x wraps, y clamps to the edge). */
export function lngLatToTile(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const z = clampRasterZoom(zoom);
  const n = 2 ** z;
  const x = Math.floor(((wrapLng(lng) + 180) / 360) * n) % n;
  const clamped = clampLat(lat);
  const latRad = (clamped * Math.PI) / 180;
  const mercator = Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI;
  const y = Math.min(n - 1, Math.max(0, Math.floor(((1 - mercator) / 2) * n)));
  return { x: ((x % n) + n) % n, y };
}

/**
 * 3x3 tile grid around the center tile. X neighbours wrap at the
 * antimeridian (columns are never dropped); Y neighbours clamp at the poles.
 */
export function rasterTilesForCenter(center: RasterCenter, zoom: number): RasterTile[] {
  const z = clampRasterZoom(zoom);
  const n = 2 ** z;
  const middle = lngLatToTile(center.lng, center.lat, z);
  const tiles: RasterTile[] = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = (((middle.x + dx) % n) + n) % n;
      const y = Math.min(n - 1, Math.max(0, middle.y + dy));
      tiles.push({ x, y, z, url: rasterTileUrl(x, y, z) });
    }
  }
  return tiles;
}

/**
 * Pan the fallback center by whole-tile fractions (dx east, dy south) at a
 * zoom. Used by the picker's fallback nudge pad so the pin stays placeable
 * without WebGL — and offline, where search cannot run.
 */
export function nudgeCenter(
  center: RasterCenter,
  zoom: number,
  dxTiles: number,
  dyTiles: number,
): RasterCenter {
  const z = clampRasterZoom(zoom);
  const n = 2 ** z;
  const fx = (((center.lng + 180) / 360) * n + dxTiles) % n;
  const lng = (((((fx % n) + n) % n) / n) * 360 - 180 + 540) % 360 - 180;
  const latRad = (clampLat(center.lat) * Math.PI) / 180;
  const fy =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n + dyTiles;
  const clampedFy = Math.min(n - 0.001, Math.max(0.001, fy));
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * clampedFy) / n))) * 180) / Math.PI;
  return { lat, lng };
}

/**
 * Gate Map construction on a non-zero container.
 *
 * Building a native map inside a 0x0 box (BottomSheet open animation, first
 * layout pass on Android WebView) misplaces the native view.
 * When the container already has size this resolves synchronously; otherwise
 * it waits a frame pair for layout and then resolves anyway — the caller
 * still constructs and follows up with `resize()`, so a pathological 0x0
 * container degrades to the load-timeout path instead of hanging.
 */
export async function waitForContainerLayout(element: HTMLElement): Promise<void> {
  const rect = element.getBoundingClientRect();
  if ((rect.width > 0 && rect.height > 0) || (element.clientWidth > 0 && element.clientHeight > 0)) {
    return;
  }
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    } else {
      resolve();
    }
  });
}
