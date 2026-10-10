/**
 * Unified place-search seam for the map picker (A3).
 *
 * Order: native Google Places SDK first (autocomplete + fetchPlace through
 * the `FindbackPlaces` bridge — works with the Android-app-restricted key),
 * Nominatim second (web builds, missing native key, native failure). The
 * `PlaceResult` shape is preserved exactly, so callers and the
 * approximate-by-default commit path are untouched by the provider switch.
 *
 * Policy preserved from `nominatimSearch.ts`: searches run ONLY on explicit
 * user submission — there is intentionally NO keystroke-autocomplete path
 * here. The native bridge debounces per call; the Nominatim throttler floor
 * (≤1 req/s) is honored on the fallback path.
 */

import {
  NominatimThrottler,
  resolveNominatimConfig,
  searchPlaces as searchNominatim,
  type NominatimSearchOverride,
  type PlaceResult,
} from "./nominatimSearch";
import {
  PlacesSearchError,
  searchPlacesNative,
} from "../../native/googlePlaces";

export type PlacesSearchSource = "places" | "nominatim";

export interface UnifiedSearchResult {
  places: PlaceResult[];
  /** Which provider answered (drives the attribution line). */
  source: PlacesSearchSource;
}

export interface UnifiedSearchOptions {
  /** Search-endpoint seam for the Nominatim fallback path. */
  nominatimOverride?: NominatimSearchOverride;
  throttler?: NominatimThrottler;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  now?: number;
  maxResults?: number;
  /** Injectable native transport (tests); defaults to the real bridge. */
  nativeSearch?: (query: string) => Promise<PlaceResult[]>;
}

/** Attribution surfaces showing results must render for the used source. */
export function attributionForSource(source: PlacesSearchSource): string {
  return source === "places"
    ? "Powered by Google"
    : resolveNominatimConfig().attribution;
}

function sanitizePlaces(places: unknown, limit: number): PlaceResult[] {
  if (!Array.isArray(places)) return [];
  const clean: PlaceResult[] = [];
  for (const item of places as Array<Partial<PlaceResult>>) {
    if (
      typeof item?.displayName !== "string" ||
      !item.displayName.trim() ||
      typeof item?.latitude !== "number" ||
      typeof item?.longitude !== "number" ||
      !Number.isFinite(item.latitude) ||
      !Number.isFinite(item.longitude)
    ) {
      continue;
    }
    clean.push({
      displayName: item.displayName,
      latitude: item.latitude,
      longitude: item.longitude,
    });
    if (clean.length >= limit) break;
  }
  return clean;
}

/**
 * Run ONE explicit user-triggered search. Native Places first, Nominatim
 * fallback — never throws for provider reasons the fallback can absorb (the
 * Nominatim rate-limit error still surfaces so the UI can say "wait a
 * moment", exactly as before).
 */
export async function searchPlacesUnified(
  query: string,
  options: UnifiedSearchOptions = {},
): Promise<UnifiedSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) return { places: [], source: "nominatim" };
  const limit = options.maxResults ?? 5;
  const native = options.nativeSearch ?? searchPlacesNative;
  try {
    const places = sanitizePlaces(await native(trimmed), limit);
    return { places, source: "places" };
  } catch (err) {
    // A missing/unconfigured bridge is the normal web + keyless path — fall
    // through silently. A native failure also falls back so search keeps
    // working; only unexpected (non-bridge) errors propagate.
    if (err instanceof PlacesSearchError) {
      const places = await searchNominatim(trimmed, {
        config: resolveNominatimConfig(options.nominatimOverride),
        throttler: options.throttler,
        fetcher: options.fetcher,
        signal: options.signal,
        now: options.now,
        maxResults: limit,
      });
      return { places, source: "nominatim" };
    }
    throw err;
  }
}
