/**
 * Google Maps API-key seam for the native map layer (A3).
 *
 * The key is an Android-app-restricted Maps/Places key (public identifier,
 * not a secret — it ships in the APK manifest). It reaches the client bundle
 * as `VITE_GOOGLE_MAPS_API_KEY`, derived at build time from the canonical
 * local `GOOGLE_MAPS_API_KEY` (see vite.config.ts, mirroring the Supabase
 * derivation), and reaches Android natively through the
 * `com.google.android.geo.API_KEY` manifest placeholder (see
 * app/build.gradle + AndroidManifest.xml, same env var).
 *
 * A missing key is NEVER a build failure: both map surfaces fail closed at
 * runtime with consumer-friendly copy (search + manual coordinates keep
 * working). See `docs/runbooks/google-maps-key.md` for the owner setup.
 */

function readEnv(key: string): string {
  try {
    const value = import.meta.env[key] as string | undefined;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

export interface GoogleMapsConfig {
  /** Empty when no key was provided at build time (fail-closed at runtime). */
  apiKey: string;
}

/** Resolve the effective Google Maps config. Always returns a fresh object. */
export function resolveGoogleMapsConfig(): GoogleMapsConfig {
  return { apiKey: readEnv("VITE_GOOGLE_MAPS_API_KEY") };
}

/** True when a key was baked in at build time and native maps may start. */
export function isGoogleMapsConfigured(config?: GoogleMapsConfig): boolean {
  return (config ?? resolveGoogleMapsConfig()).apiKey.trim().length > 0;
}
