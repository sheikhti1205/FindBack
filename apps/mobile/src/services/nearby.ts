import { roundToApproximate } from "../utils/location";

/**
 * Nearby discovery helpers (UXN-1).
 *
 * Privacy contract:
 * - The search center lives in private in-memory session state only: no
 *   background tracking, no DB persistence, and NEVER in the URL.
 * - The only URL parameter is `near=<radiusKm>` (e.g. `near=10`).
 * - The session is cleared on account switch and logout (see
 *   `clearUserScopedLocalState`).
 */

/** Radius options in kilometres. */
export const NEARBY_RADIUS_OPTIONS_KM = [2, 5, 10, 25, 50] as const;
export type NearbyRadiusKm = (typeof NEARBY_RADIUS_OPTIONS_KM)[number];

/** Default search radius: 10 km. */
export const DEFAULT_NEARBY_RADIUS_KM: NearbyRadiusKm = 10;

/** Recent means the last 7 days (wired to `dateFrom`). */
export const RECENT_DAYS = 7;

/** Shown wherever Nearby scope is explained: map-pin rows only. */
export const NEARBY_SHEET_NOTICE =
  "Nearby uses reports with a map pin. Reports with only a typed place name are not included.";

export function kmToMeters(km: number): number {
  return Math.round(km * 1000);
}

export interface NearbyCenter {
  lat: number;
  lng: number;
}

/**
 * Round the search center to ~100 m (3 decimals) BEFORE querying so the
 * exact fix never leaves the device.
 */
export function roundNearbyCenter(lat: number, lng: number): NearbyCenter {
  return roundToApproximate(lat, lng);
}

/**
 * Cache-identity fingerprint: rounded center + radius. Included in the feed
 * cache key; never written to the URL.
 */
export function nearbyCenterFingerprint(center: NearbyCenter, radiusM: number): string {
  return `${center.lat.toFixed(3)},${center.lng.toFixed(3)}|${radiusM}`;
}

/**
 * The single tested date helper behind Recent: ISO date (YYYY-MM-DD) N days
 * ago, used as `dateFrom`.
 */
export function recentCutoffDate(days: number = RECENT_DAYS, now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Parse the `near` URL param. Only the published radius options are valid;
 * anything else (including coordinate-looking values) is rejected so a
 * crafted link can never smuggle a center into the session.
 */
export function parseNearbyRadiusParam(value: string | null): NearbyRadiusKm | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return (NEARBY_RADIUS_OPTIONS_KM as readonly number[]).includes(n)
    ? (n as NearbyRadiusKm)
    : null;
}

export interface NearbySession {
  center: NearbyCenter | null;
  radiusKm: NearbyRadiusKm;
  active: boolean;
}

const initialSession = (): NearbySession => ({
  center: null,
  radiusKm: DEFAULT_NEARBY_RADIUS_KM,
  active: false,
});

/** Private in-memory session state for the Nearby search center. */
let session: NearbySession = initialSession();

export function getNearbySession(): NearbySession {
  return { ...session, center: session.center ? { ...session.center } : null };
}

export function setNearbySession(patch: Partial<NearbySession>): void {
  session = {
    ...session,
    ...patch,
    center: patch.center !== undefined
      ? patch.center
      : session.center,
  };
}

/** Drops the center, radius preference and active flag (logout/switch). */
export function clearNearbySession(): void {
  session = initialSession();
}
