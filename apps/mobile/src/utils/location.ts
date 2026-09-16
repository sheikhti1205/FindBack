/**
 * Location input parsing for the report form.
 *
 * Accepts:
 * 1. place/area text (kept as a searchable label)
 * 2. decimal lat,lng (lat first, never silently swapped)
 * 3. Google Maps URLs (query / @coords / center / search)
 * 4. geo URIs (geo:lat,lng)
 * 5. Plus Code / address as a searchable label even if not decoded
 *
 * Short links (maps.app.goo.gl and approved Google hosts) are resolved
 * natively with an allowlist, bounded redirects, timeout, no cookies/auth,
 * and rejection of redirects to arbitrary hosts.
 */

export interface ParsedLocation {
  /** User-readable label (place text, or the original input). */
  label: string;
  latitude: number | null;
  longitude: number | null;
  /** True when coordinates came from a URL/geo URI rather than typed text. */
  fromUrl: boolean;
  /** True when the input was a short link that needs native resolution. */
  needsResolve: boolean;
  /** Human-readable error when the input is invalid, else null. */
  error: string | null;
}

/** Google Maps hosts allowed for short-link resolution. */
export const ALLOWED_MAPS_HOSTS = [
  "maps.app.goo.gl",
  "goo.gl",
  "maps.google.com",
  "www.google.com",
  "google.com",
  "maps.google.co.uk",
  "maps.google.co.jp",
  "maps.google.de",
  "maps.google.fr",
  "maps.google.it",
  "maps.google.es",
  "maps.google.ca",
  "maps.google.com.au",
  "maps.google.co.in",
] as const;

const DECIMAL_PAIR =
  /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** Validate a decimal latitude/longitude pair. Lat first, never swap. */
export function validateDecimalPair(
  lat: number,
  lng: number,
): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: "Coordinates must be numbers." };
  }
  if (lat < -90 || lat > 90) {
    return { ok: false, error: "Latitude must be between -90 and 90." };
  }
  if (lng < -180 || lng > 180) {
    return { ok: false, error: "Longitude must be between -180 and 180." };
  }
  return { ok: true };
}

/** Round coordinates to ~100m precision (3 decimals) for approximate mode. */
export function roundToApproximate(lat: number, lng: number): { lat: number; lng: number } {
  return {
    lat: Math.round(lat * 1000) / 1000,
    lng: Math.round(lng * 1000) / 1000,
  };
}

/** Extract a decimal lat,lng pair from a Google Maps URL, or null. */
export function extractCoordsFromMapsUrl(url: string): { lat: number; lng: number } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  // /maps/search/?api=1&query=LAT,LNG
  const query = u.searchParams.get("query");
  if (query) {
    const m = DECIMAL_PAIR.exec(query);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (validateDecimalPair(lat, lng).ok) return { lat, lng };
    }
  }

  // ?q=LAT,LNG
  const q = u.searchParams.get("q");
  if (q) {
    const m = DECIMAL_PAIR.exec(q);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (validateDecimalPair(lat, lng).ok) return { lat, lng };
    }
  }

  // ?center=LAT,LNG
  const center = u.searchParams.get("center");
  if (center) {
    const m = DECIMAL_PAIR.exec(center);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (validateDecimalPair(lat, lng).ok) return { lat, lng };
    }
  }

  // @LAT,LNG in the path (e.g. /maps/@23.8,90.4,15z)
  const atMatch = /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(u.pathname + u.search);
  if (atMatch) {
    const lat = Number(atMatch[1]);
    const lng = Number(atMatch[2]);
    if (validateDecimalPair(lat, lng).ok) return { lat, lng };
  }

  return null;
}

/** Extract a decimal lat,lng pair from a geo URI (geo:lat,lng), or null. */
export function extractCoordsFromGeoUri(input: string): { lat: number; lng: number } | null {
  const m = /^geo:(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(input.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!validateDecimalPair(lat, lng).ok) return null;
  return { lat, lng };
}

/** True when the input is a short link on an allowlisted Google host. */
export function isAllowlistedShortLink(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return false;
  }
  return ALLOWED_MAPS_HOSTS.includes(u.hostname as (typeof ALLOWED_MAPS_HOSTS)[number]);
}

/**
 * Resolve a short Google Maps link natively.
 * - allowlist hosts only
 * - bounded redirects (max 5)
 * - timeout (8s)
 * - no cookies/auth
 * - reject redirects to arbitrary hosts
 */
export async function resolveShortLink(
  input: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<string> {
  let current = input.trim();
  if (!isAllowlistedShortLink(current)) {
    throw new Error("Only Google Maps short links can be resolved.");
  }

  for (let hop = 0; hop < 5; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res: Response;
    try {
      res = await fetcher(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
    } catch (err) {
      throw new Error(
        err instanceof Error && err.name === "AbortError"
          ? "Timed out resolving the map link."
          : "Could not resolve the map link.",
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("Map link did not redirect.");
      const next = new URL(location, current).toString();
      const nextHost = new URL(next).hostname;
      if (!ALLOWED_MAPS_HOSTS.includes(nextHost as (typeof ALLOWED_MAPS_HOSTS)[number])) {
        throw new Error("Map link redirected to an untrusted host.");
      }
      current = next;
      continue;
    }

    return current;
  }

  throw new Error("Map link redirected too many times.");
}

/**
 * Parse a single location input into a ParsedLocation.
 * Never fabricates coordinates: if none can be extracted, the input is kept
 * as a user-readable label and Open in Maps remains allowed.
 */
export function parseLocationInput(input: string): ParsedLocation {
  const trimmed = input.trim();
  if (!trimmed) {
    return { label: "", latitude: null, longitude: null, fromUrl: false, needsResolve: false, error: null };
  }

  // geo URI
  const geo = extractCoordsFromGeoUri(trimmed);
  if (geo) {
    return {
      label: "Pinned location",
      latitude: geo.lat,
      longitude: geo.lng,
      fromUrl: true,
      needsResolve: false,
      error: null,
    };
  }

  // Google Maps URL
  if (/^https?:\/\//i.test(trimmed)) {
    const coords = extractCoordsFromMapsUrl(trimmed);
    if (coords) {
      return {
        label: "Pinned location",
        latitude: coords.lat,
        longitude: coords.lng,
        fromUrl: true,
        needsResolve: false,
        error: null,
      };
    }
    if (isAllowlistedShortLink(trimmed)) {
      return {
        label: trimmed,
        latitude: null,
        longitude: null,
        fromUrl: true,
        needsResolve: true,
        error: null,
      };
    }
    // A maps URL with no extractable coords: keep as label, no fabricated coords.
    return {
      label: trimmed,
      latitude: null,
      longitude: null,
      fromUrl: true,
      needsResolve: false,
      error: null,
    };
  }

  // Decimal lat,lng pair
  const pair = DECIMAL_PAIR.exec(trimmed);
  if (pair) {
    const lat = Number(pair[1]);
    const lng = Number(pair[2]);
    const check = validateDecimalPair(lat, lng);
    if (!check.ok) {
      return { label: trimmed, latitude: null, longitude: null, fromUrl: false, needsResolve: false, error: check.error };
    }
    return {
      label: "Pinned location",
      latitude: lat,
      longitude: lng,
      fromUrl: false,
      needsResolve: false,
      error: null,
    };
  }

  // Place/area text (or Plus Code / address kept as a searchable label).
  return {
    label: trimmed,
    latitude: null,
    longitude: null,
    fromUrl: false,
    needsResolve: false,
    error: null,
  };
}

/** Build an Android ACTION_VIEW geo: URI for a coordinate pair. */
export function geoUri(lat: number, lng: number): string {
  return `geo:${lat},${lng}?q=${lat},${lng}`;
}

/** Build a keyless Google Maps search URL for a label or coordinate pair. */
export function mapsSearchUrl(lat: number | null, lng: number | null, label: string): string {
  if (lat != null && lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label)}`;
}

/** Open a location in the external Maps app via ACTION_VIEW. */
export function openInMaps(lat: number | null, lng: number | null, label: string): void {
  const url = lat != null && lng != null ? geoUri(lat, lng) : mapsSearchUrl(null, null, label);
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Helper text for the Find-in-Maps flow. */
export const FIND_IN_MAPS_HELP =
  "Drop/search a pin, copy the coordinates or Maps link, then paste it here.";