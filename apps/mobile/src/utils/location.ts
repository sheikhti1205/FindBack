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

import { AppLauncher } from "@capacitor/app-launcher";
import { Capacitor, registerPlugin } from "@capacitor/core";

interface ShortLinkResolverPlugin {
  resolve(options: { url: string }): Promise<{ url: string }>;
}

const ShortLinkResolver = Capacitor.isNativePlatform()
  ? registerPlugin<ShortLinkResolverPlugin>("ShortLinkResolver")
  : undefined;

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
): { ok: true; error?: never } | { ok: false; error: string } {
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

/**
 * Hosts that exist only to redirect to a Maps destination.
 *
 * Deliberately narrower than `ALLOWED_MAPS_HOSTS`: a full
 * `www.google.com/maps/place/...` URL is already the destination. Treating it
 * as something to resolve made the picker fetch a page it could not parse and
 * then report a failure instead of keeping the pasted link as a label.
 */
export const SHORT_LINK_HOSTS = ["maps.app.goo.gl", "goo.gl"];

/** https on the default port — a share link never needs anything else, and a
 * non-default port is an escape hatch around the host rules. */
function isHttpsDefaultPort(u: URL): boolean {
  return u.protocol === "https:" && (u.port === "" || u.port === "443");
}

/** True when the URL is on a Maps host we are willing to fetch or follow. */
function isAllowlistedMapsUrl(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return false;
  }
  // https only: a resolved location is user data, and following an http hop
  // would let the network rewrite it in transit.
  return isHttpsDefaultPort(u)
    && ALLOWED_MAPS_HOSTS.includes(u.hostname as (typeof ALLOWED_MAPS_HOSTS)[number]);
}

/**
 * True when the URL is a Maps *destination*: a place a reader can be sent to.
 *
 * Not the same as "on an allowlisted host". `goo.gl` shortens more than maps
 * links, so a short link can land on `https://www.google.com/` — a real Google
 * page, an allowlisted host, and not a location. A terminal URL is only a
 * resolution when it is the Maps product itself: a `maps.*` host, or the
 * `/maps` path on a bare Google host.
 */
function isMapsDestination(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return false;
  }
  if (!isHttpsDefaultPort(u)) return false;
  if (!ALLOWED_MAPS_HOSTS.includes(u.hostname as (typeof ALLOWED_MAPS_HOSTS)[number])) return false;
  if (SHORT_LINK_HOSTS.includes(u.hostname as (typeof SHORT_LINK_HOSTS)[number])) return false;
  if (u.hostname.startsWith("maps.")) return true;
  return u.pathname === "/maps" || u.pathname.startsWith("/maps/");
}

/** True when the input is a short link on an allowlisted Google host. */
export function isAllowlistedShortLink(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return false;
  }
  return isHttpsDefaultPort(u)
    && SHORT_LINK_HOSTS.includes(u.hostname as (typeof SHORT_LINK_HOSTS)[number]);
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
  if (!isAllowlistedMapsUrl(current)) {
    throw new Error("Only Google Maps links can be resolved.");
  }
  // A full Maps URL is already the destination: there is nothing to follow, and
  // fetching it would only parse a page the caller already has.
  if (!isAllowlistedShortLink(current)) {
    if (!isMapsDestination(current)) throw new Error("Only Google Maps links can be resolved.");
    return current;
  }

  // Use native resolver on Android
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android" && ShortLinkResolver) {
    try {
      const result = await ShortLinkResolver.resolve({ url: current });
      return result.url;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "Could not resolve the map link.");
    }
  }

  // Web fallback: fetch-based resolution
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

    // Browsers never expose a cross-origin redirect's Location header with
    // `redirect: "manual"`: they return an opaque response instead. Returning
    // `current` here would report the *short link* as resolved, so the caller
    // would store a label with no coordinates and no error.
    if (res.type === "opaqueredirect" || res.status === 0) {
      throw new Error(
        "This browser cannot follow the map link. Paste the coordinates or open it in Maps.",
      );
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("Map link did not redirect.");
      const next = new URL(location, current);
      if (!isHttpsDefaultPort(next)
        || !ALLOWED_MAPS_HOSTS.includes(next.hostname as (typeof ALLOWED_MAPS_HOSTS)[number])) {
        throw new Error("Map link redirected to an untrusted host.");
      }
      current = next.toString();
      continue;
    }

    // A resolution has to land on a Maps destination. A 2xx with no redirect
    // never moved; a redirect back to itself ends where it began; a chain that
    // ends on another shortener has followed one redirect and still resolved
    // nothing; and a `goo.gl` link that lands on the Google homepage reached an
    // allowlisted page that is not a location. All four would otherwise be
    // reported as the resolved location, with no coordinates and no error.
    if (!isMapsDestination(current)) throw new Error("Map link did not redirect to a location.");
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
      const err = check.error;
      return { label: trimmed, latitude: null, longitude: null, fromUrl: false, needsResolve: false, error: err };
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
  void openInMapsNative(lat, lng, label);
}

/** Universal Maps URL (openable everywhere) for a coordinate pair or label. */
export function universalMapsUrl(lat: number | null, lng: number | null, label: string): string {
  return mapsSearchUrl(lat, lng, label);
}

/**
 * External map handoff.
 *
 * On Android we open the universal Maps URL through AppLauncher, which
 * starts a real external ACTION_VIEW (the installed Maps app claims it via App
 * Links). Falling back to a new WebView window keeps the web build working.
 */
export async function openInMapsNative(lat: number | null, lng: number | null, label: string): Promise<void> {
  const universal = universalMapsUrl(lat, lng, label);
  if (Capacitor.isNativePlatform()) {
    try {
      await AppLauncher.openUrl({ url: universal });
      return;
    } catch {
      /* fall through to the browser handoff */
    }
  }
  window.open(universal, "_blank", "noopener,noreferrer");
}

/** Helper text for the Find-in-Maps flow. */
export const FIND_IN_MAPS_HELP =
  "Drop/search a pin, copy the coordinates or Maps link, then paste it here.";