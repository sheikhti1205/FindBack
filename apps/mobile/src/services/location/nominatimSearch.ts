/**
 * Submit-only place search seam for the interactive picker.
 *
 * Called ONLY on explicit user submission (a Search button / form submit).
 * There is intentionally NO keystroke autocomplete path here: the public
 * Nominatim endpoint forbids client-side autocomplete, and every request must
 * stay user-triggered, moderate-volume, and cacheable/proxiable.
 *
 * Endpoint isolation: consumers resolve the endpoint through
 * {@link resolveNominatimConfig} (explicit override → `VITE_NOMINATIM_SEARCH_URL`
 * build-time override → public default). A controlled Nominatim proxy/cache is
 * FUTURE work — when it exists, point the override at it; no call-site change
 * is needed.
 *
 * Usage-policy compliance (enforced here, not just documented):
 * - ≤1 request/second via {@link NominatimThrottler} (default 1100 ms floor).
 * - A browser WebView cannot set the `User-Agent` header (it is a forbidden
 *   header), so browser builds identify via origin/Referer automatically.
 *   Native/proxy deployments MUST set `User-Agent: FindBack/<version> (...)`
 *   plus a contact Referer on the outgoing request — that header belongs in
 *   the proxy (future work), never in WebView JS.
 * - Results carry the {@link DEFAULT_NOMINATIM_CONFIG.attribution} string;
 *   surfaces that show results must render it.
 */

export interface NominatimSearchConfig {
  /** Nominatim `/search` endpoint (or the future controlled proxy URL). */
  endpoint: string;
  /** Attribution surfaces showing results must render. */
  attribution: string;
}

export interface NominatimSearchOverride {
  endpoint?: string;
}

export const DEFAULT_NOMINATIM_CONFIG: NominatimSearchConfig = {
  endpoint: "https://nominatim.openstreetmap.org/search",
  attribution: "© OpenStreetMap contributors (Nominatim, ODbL)",
};

/** Minimum gap between two search requests — enforces ≤1 req/s. */
export const NOMINATIM_MIN_INTERVAL_MS = 1100;

export interface PlaceResult {
  displayName: string;
  latitude: number;
  longitude: number;
}

export class NominatimRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("Please wait a moment and try the search again.");
    this.name = "NominatimRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

function readEnv(key: string): string | undefined {
  try {
    const value = import.meta.env[key] as string | undefined;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective search endpoint.
 * Precedence: explicit override → `VITE_NOMINATIM_SEARCH_URL` → public default.
 */
export function resolveNominatimConfig(
  override?: NominatimSearchOverride,
): NominatimSearchConfig {
  return {
    ...DEFAULT_NOMINATIM_CONFIG,
    endpoint:
      override?.endpoint?.trim() ||
      readEnv("VITE_NOMINATIM_SEARCH_URL") ||
      DEFAULT_NOMINATIM_CONFIG.endpoint,
  };
}

/** Enforces the ≤1 req/s floor with an injectable clock (testable). */
export class NominatimThrottler {
  private lastRequestAt: number | null = null;

  tryAcquire(now: number): { ok: true } | { ok: false; retryAfterMs: number } {
    if (
      this.lastRequestAt != null &&
      now - this.lastRequestAt < NOMINATIM_MIN_INTERVAL_MS
    ) {
      return {
        ok: false,
        retryAfterMs: NOMINATIM_MIN_INTERVAL_MS - (now - this.lastRequestAt),
      };
    }
    this.lastRequestAt = now;
    return { ok: true };
  }
}

interface RawSearchItem {
  display_name?: unknown;
  lat?: unknown;
  lon?: unknown;
}

function toPlaceResult(item: RawSearchItem): PlaceResult | null {
  if (typeof item.display_name !== "string" || !item.display_name.trim()) {
    return null;
  }
  const latitude = Number(item.lat);
  const longitude = Number(item.lon);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { displayName: item.display_name, latitude, longitude };
}

export interface SearchPlacesOptions {
  config?: NominatimSearchConfig;
  throttler?: NominatimThrottler;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  /** Injectable clock (defaults to Date.now). */
  now?: number;
  maxResults?: number;
}

/**
 * Run ONE explicit user-triggered search. Never call per keystroke.
 * Throws {@link NominatimRateLimitError} when called within
 * {@link NOMINATIM_MIN_INTERVAL_MS} of the previous request.
 */
export async function searchPlaces(
  query: string,
  options: SearchPlacesOptions = {},
): Promise<PlaceResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const config = options.config ?? DEFAULT_NOMINATIM_CONFIG;
  const acquired = (options.throttler ?? new NominatimThrottler()).tryAcquire(
    options.now ?? Date.now(),
  );
  if (!acquired.ok) {
    throw new NominatimRateLimitError(acquired.retryAfterMs);
  }
  const limit = options.maxResults ?? 5;
  const url =
    `${config.endpoint}?format=jsonv2&limit=${limit}` +
    `&q=${encodeURIComponent(trimmed)}`;
  const fetcher = options.fetcher ?? fetch;
  // NOTE: no User-Agent header — browsers forbid it; identity for the
  // native/proxy path is documented at the top of this file.
  const res = await fetcher(url, {
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  if (!res.ok) {
    throw new Error("Place search failed — pan the map and confirm the pin instead.");
  }
  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) return [];
  const places: PlaceResult[] = [];
  for (const item of raw as RawSearchItem[]) {
    const place = toPlaceResult(item);
    if (place) places.push(place);
    if (places.length >= limit) break;
  }
  return places;
}
