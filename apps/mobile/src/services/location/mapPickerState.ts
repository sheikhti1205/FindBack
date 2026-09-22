/**
 * Start-order + commit semantics for the interactive map picker.
 *
 * `LocationValue` semantics are preserved EXACTLY as in LocationPicker:
 * - `label / latitude / longitude / precision / preciseLatitude /
 *   preciseLongitude` shape (imported as a type — no duplication to drift).
 * - Approximate-by-default: commits round through `roundToApproximate`
 *   (~100 m, 3 decimals) while the unrounded fix is retained in
 *   `preciseLatitude/preciseLongitude` so exact opt-in restores it.
 * - GPS never silently commits: a GPS fix only recenters the sheet preview
 *   (see `resolveInitialView`'s `gps-preview` source); coordinates enter the
 *   draft ONLY through {@link commitCenterAsLocation}, i.e. the explicit
 *   Confirm path with rounding applied — same as manual pans.
 */

import type { LocationValue } from "../../components/LocationPicker";
import { roundToApproximate } from "../../utils/location";

export interface MapCenter {
  lat: number;
  lng: number;
}

export type InitialViewSource =
  | "report-pin"
  | "search-result"
  | "gps-preview"
  | "neutral-world";

export interface InitialView {
  /** Camera center. World-view fallback — never presented as a pin default. */
  center: MapCenter;
  zoom: number;
  source: InitialViewSource;
}

/** Neutral world camera: whole-world view, not any country. */
export const WORLD_VIEW_CENTER: MapCenter = { lat: 0, lng: 0 };
export const WORLD_VIEW_ZOOM = 1;
/** Close-up camera used once a real pin / result / preview exists. */
export const PIN_ZOOM = 15;

export function isValidCenter(value: unknown): value is MapCenter {
  if (typeof value !== "object" || value === null) return false;
  const { lat, lng } = value as { lat?: unknown; lng?: unknown };
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export interface InitialViewInput {
  /** Existing report pin — start-order #1. */
  reportPin?: MapCenter | null;
  /** Chosen search result — start-order #2. */
  searchResult?: MapCenter | null;
  /**
   * Current-location fix from an EXPLICIT "use my location once" tap.
   * Preview recenter only — never auto-committed (start-order #3).
   */
  gpsPreview?: MapCenter | null;
}

/**
 * Start-order: existing report pin → search result → GPS preview (explicit
 * tap only) → neutral world state. Never defaults to any country.
 */
export function resolveInitialView(input: InitialViewInput): InitialView {
  if (isValidCenter(input.reportPin)) {
    return { center: input.reportPin, zoom: PIN_ZOOM, source: "report-pin" };
  }
  if (isValidCenter(input.searchResult)) {
    return { center: input.searchResult, zoom: PIN_ZOOM, source: "search-result" };
  }
  if (isValidCenter(input.gpsPreview)) {
    return { center: input.gpsPreview, zoom: PIN_ZOOM, source: "gps-preview" };
  }
  return { center: WORLD_VIEW_CENTER, zoom: WORLD_VIEW_ZOOM, source: "neutral-world" };
}

/** True when the view carries no pin yet (neutral world start state). */
export function isNeutralView(view: InitialView): boolean {
  return view.source === "neutral-world";
}

/**
 * Commit a map center as a LocationValue. Mirrors LocationPicker's setCoords
 * branch-for-branch: null clears, EXACT keeps full precision, otherwise the
 * published coordinates are rounded to ~100 m with the precise fix retained.
 */
export function commitCenterAsLocation(
  label: string,
  center: MapCenter | null,
  precision: "APPROXIMATE" | "EXACT",
): LocationValue {
  if (center == null) {
    return {
      label,
      latitude: null,
      longitude: null,
      precision: "APPROXIMATE",
      preciseLatitude: null,
      preciseLongitude: null,
    };
  }
  if (precision === "EXACT") {
    return {
      label,
      latitude: center.lat,
      longitude: center.lng,
      precision: "EXACT",
      preciseLatitude: center.lat,
      preciseLongitude: center.lng,
    };
  }
  const rounded = roundToApproximate(center.lat, center.lng);
  return {
    label,
    latitude: rounded.lat,
    longitude: rounded.lng,
    precision: "APPROXIMATE",
    preciseLatitude: center.lat,
    preciseLongitude: center.lng,
  };
}

/**
 * Coordinate readout mirroring LocationPicker: approximate pins show the
 * 3 decimals they were rounded to (matching the ~100 m claim), exact pins
 * show full stored precision. Never implies more precision than the mode.
 */
export function formatCoordinateReadout(
  value: Pick<LocationValue, "latitude" | "longitude" | "precision">,
): string | null {
  if (value.latitude == null || value.longitude == null) return null;
  return value.precision === "EXACT"
    ? `${value.latitude}, ${value.longitude}`
    : `${value.latitude.toFixed(3)}, ${value.longitude.toFixed(3)}`;
}
