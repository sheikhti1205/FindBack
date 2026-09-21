/**
 * Replaceable map tile source configuration for the interactive picker.
 *
 * The tile endpoint is NEVER hard-coded at usage sites: every consumer goes
 * through {@link resolveMapSource}, which layers an explicit per-call
 * override over the `VITE_MAP_STYLE_URL` / `VITE_MAP_ATTRIBUTION` build-time
 * overrides over the built-in default. Pointing the app at a self-hosted
 * tileserver, a PMTiles gateway, or a commercial provider is a config change,
 * never a code change.
 *
 * GATE — default tile source eligibility (UNRESOLVED at implementation time):
 * the built-in default points at the OpenFreeMap public instance (see
 * `DEFAULT_MAP_SOURCE`). Before shipping a build that loads this default, the
 * integrator MUST confirm eligibility under the OpenFreeMap terms of service —
 * in particular the 18+/contract-capacity eligibility question, which is still
 * open. If eligibility cannot be confirmed, ship with an override (self-hosted
 * or commercial style URL + matching attribution) instead. The demo tiles at
 * `demotiles.maplibre.org` are NOT a production option either.
 */

export interface MapSourceConfig {
  /** Human-readable source name, shown in the picker attribution footer. */
  name: string;
  /** MapLibre style JSON URL (e.g. an OpenFreeMap style or a self-hosted one). */
  styleUrl: string;
  /**
   * Plain-text attribution rendered in the picker footer. Overrides MUST keep
   * attribution for the data they serve (OpenStreetMap contributors at least).
   */
  attribution: string;
}

export interface MapSourceOverride {
  styleUrl?: string;
  name?: string;
  attribution?: string;
}

/**
 * Built-in default behind the config seam. This is a default, not the only
 * source — see the GATE note above before shipping with it.
 */
export const DEFAULT_MAP_SOURCE: MapSourceConfig = {
  name: "OpenFreeMap",
  styleUrl: "https://tiles.openfreemap.org/styles/liberty",
  attribution: "© OpenMapTiles © OpenStreetMap contributors",
};

/** Alternate OpenFreeMap styles usable as overrides without code changes. */
export const OPENFREEMAP_STYLE_BRIGHT = "https://tiles.openfreemap.org/styles/bright";
export const OPENFREEMAP_STYLE_POSITRON = "https://tiles.openfreemap.org/styles/positron";

function readEnv(key: string): string | undefined {
  try {
    const value = import.meta.env[key] as string | undefined;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective tile source.
 * Precedence: explicit override → `VITE_MAP_STYLE_URL` (+ optional
 * `VITE_MAP_NAME` / `VITE_MAP_ATTRIBUTION`) → {@link DEFAULT_MAP_SOURCE}.
 * Never mutates the default; always returns a fresh object.
 */
export function resolveMapSource(override?: MapSourceOverride): MapSourceConfig {
  const envStyleUrl = readEnv("VITE_MAP_STYLE_URL");
  const envName = readEnv("VITE_MAP_NAME");
  const envAttribution = readEnv("VITE_MAP_ATTRIBUTION");
  const styleUrl =
    override?.styleUrl?.trim() || envStyleUrl || DEFAULT_MAP_SOURCE.styleUrl;
  return {
    name: override?.name?.trim() || envName || DEFAULT_MAP_SOURCE.name,
    styleUrl,
    attribution:
      override?.attribution?.trim() || envAttribution || DEFAULT_MAP_SOURCE.attribution,
  };
}
