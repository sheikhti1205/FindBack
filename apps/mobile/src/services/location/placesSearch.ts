/**
 * Unified place-search seam for the map picker (keyless MAP pivot).
 *
 * Nominatim explicit-submit ONLY: no Google Places SDK, no native bridge, no
 * provider ordering. The `PlaceResult` shape is preserved exactly, so callers
 * and the approximate-by-default commit path are untouched by the provider
 * switch.
 *
 * Policy preserved from `nominatimSearch.ts`: searches run ONLY on explicit
 * user submission — there is intentionally NO keystroke-autocomplete path
 * here. The Nominatim throttler floor (≤1 req/s) is honored on every call.
 */

import {
  NominatimThrottler,
  resolveNominatimConfig,
  searchPlaces as searchNominatim,
  type NominatimSearchOverride,
  type PlaceResult,
} from "./nominatimSearch";

export type SearchSource = "nominatim";

export interface UnifiedSearchResult {
  places: PlaceResult[];
  /** Which provider answered (drives the attribution line). */
  source: SearchSource;
}

export interface UnifiedSearchOptions {
  /** Search-endpoint seam (the future controlled proxy plugs in here). */
  nominatimOverride?: NominatimSearchOverride;
  throttler?: NominatimThrottler;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  now?: number;
  maxResults?: number;
}

/** Attribution surfaces showing results must render. */
export function attributionForSource(): string {
  return resolveNominatimConfig().attribution;
}

/**
 * Run ONE explicit user-triggered search against Nominatim.
 * The Nominatim rate-limit error still surfaces so the UI can say "wait a
 * moment", exactly as before.
 */
export async function searchPlacesUnified(
  query: string,
  options: UnifiedSearchOptions = {},
): Promise<UnifiedSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) return { places: [], source: "nominatim" };
  const places = await searchNominatim(trimmed, {
    config: resolveNominatimConfig(options.nominatimOverride),
    throttler: options.throttler,
    fetcher: options.fetcher,
    signal: options.signal,
    now: options.now,
    maxResults: options.maxResults ?? 5,
  });
  return { places, source: "nominatim" };
}
