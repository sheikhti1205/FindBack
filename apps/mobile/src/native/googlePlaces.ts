/**
 * A3 — Google Places native search bridge facade.
 *
 * The native side is `FindbackPlacesPlugin.java` (Places SDK autocomplete +
 * fetchPlace, key read from the `com.google.android.geo.API_KEY` manifest
 * entry at runtime — never in code). This module is the only JS surface the
 * unified place search (`services/location/placesSearch.ts`) touches.
 *
 * Fail-closed rules:
 * - off Android (or bridge missing) every call reports `available: false`
 *   and the caller falls back to Nominatim — search never hard-fails for
 *   lack of a native bridge,
 * - native errors surface as `PlacesSearchError` with our own stable,
 *   consumer-safe message — never raw platform text (which could echo key
 *   material or internal state),
 * - the API key is NEVER read, logged, or printed here.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PlaceResult } from "../services/location/nominatimSearch";

export type PlacesSearchFailureKind = "unavailable" | "misconfigured" | "failed";

export class PlacesSearchError extends Error {
  readonly kind: PlacesSearchFailureKind;
  constructor(kind: PlacesSearchFailureKind) {
    super(
      kind === "unavailable"
        ? "Place search is not available on this device."
        : kind === "misconfigured"
          ? "Place search is not set up yet."
          : "Place search failed.",
    );
    this.name = "PlacesSearchError";
    this.kind = kind;
  }
}

interface NativeFindbackPlaces {
  isAvailable(): Promise<{ available: boolean }>;
  searchPlaces(options: { query: string }): Promise<{ results: PlaceResult[] }>;
}

function nativeBridge(): NativeFindbackPlaces | null {
  try {
    if (!Capacitor.isNativePlatform()) return null;
    return registerPlugin<NativeFindbackPlaces>("FindbackPlaces");
  } catch {
    return null;
  }
}

/** True on a native build where the FindbackPlaces plugin can exist. */
export function isNativePlacesSearchAvailable(): boolean {
  return nativeBridge() !== null;
}

/**
 * Explicit user-triggered place search through the native Places SDK.
 * Rejects with {@link PlacesSearchError}: `unavailable` off-device,
 * `misconfigured` when the native key is missing, `failed` otherwise.
 * Never falls back here — the caller (`placesSearch.ts`) owns fallback.
 */
export async function searchPlacesNative(query: string): Promise<PlaceResult[]> {
  const bridge = nativeBridge();
  if (!bridge) throw new PlacesSearchError("unavailable");
  let availability: { available: boolean };
  try {
    availability = await bridge.isAvailable();
  } catch {
    throw new PlacesSearchError("failed");
  }
  if (!availability?.available) throw new PlacesSearchError("misconfigured");
  try {
    const result = await bridge.searchPlaces({ query });
    return Array.isArray(result?.results) ? result.results : [];
  } catch {
    throw new PlacesSearchError("failed");
  }
}
