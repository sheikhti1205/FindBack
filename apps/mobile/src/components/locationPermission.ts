/**
 * One-time coarse geolocation seam shared by the report form's location
 * controls.
 *
 * Design contract (deliberate, tested):
 * - Nothing here runs by itself. A request starts only inside an explicit
 *   user gesture, and concurrent taps collapse into a single platform prompt.
 * - The platform options are always coarse (`enableHighAccuracy: false`) with
 *   a bounded timeout: this app never asks for a precise GPS fix.
 * - Every failure mode is a distinct, actionable reason — never one generic
 *   "could not get your location" string.
 * - A fix whose reported accuracy is coarser than the published ~100 m pin is
 *   never attached silently: callers get it as `granted` with a non-null
 *   `accuracyMeters` and must ask the user to confirm.
 *
 * The Android runtime dialog itself is launched by Capacitor's
 * `BridgeWebChromeClient.onGeolocationPermissionsShowPrompt`, which requests
 * both `ACCESS_COARSE_LOCATION` and `ACCESS_FINE_LOCATION` (falling back to
 * coarse-only on API 31+). That is why both manifest permissions are kept.
 */

export type LocationFailureReason =
  /** The OS/browser permission prompt was refused. */
  | "denied"
  /** The device has location services switched off. */
  | "disabled"
  /** No fix arrived within the bounded timeout. */
  | "timeout"
  /** Any other platform failure — position unavailable, aborted, thrown. */
  | "unavailable"
  /** No geolocation API at all (e.g. a WebView without it). */
  | "unsupported";

export type LocationOutcome =
  | {
      status: "granted";
      latitude: number;
      longitude: number;
      /** Reported accuracy in metres; `null` when the platform gave none. */
      accuracyMeters: number | null;
    }
  | { status: "denied" }
  | { status: LocationFailureReason };

/** Coarse fix only: cheaper, faster, and enough for a ~100 m pin. */
export const COARSE_LOCATION_OPTIONS: PositionOptions = Object.freeze({
  enableHighAccuracy: false,
  timeout: 8000,
  maximumAge: 60000,
});

/** Published pin precision (~100 m). Anything coarser needs confirmation. */
export const LOW_ACCURACY_METERS = 500;

/** Collapses double-taps so the user only ever sees one system prompt. */
let inFlight: Promise<LocationOutcome> | null = null;

/** True when the reported accuracy is coarser than the published pin. */
export function isLowAccuracy(accuracyMeters: number | null): boolean {
  if (accuracyMeters == null || !Number.isFinite(accuracyMeters)) return false;
  return accuracyMeters > LOW_ACCURACY_METERS;
}

/** Human accuracy readout: metres below 1 km, kilometres above it. */
export function formatAccuracy(accuracyMeters: number): string {
  return accuracyMeters < 1000
    ? `~${Math.round(accuracyMeters)} m`
    : `~${(accuracyMeters / 1000).toFixed(1)} km`;
}

/** Maps a `GeolocationPositionError`-shaped value onto a reason. */
export function classifyGeolocationError(error: unknown): LocationFailureReason {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === 1) return "denied";
  if (code === 2) return "disabled";
  if (code === 3) return "timeout";
  return "unavailable";
}

/** Actionable copy per reason — no shared generic string. */
export function locationFailureMessage(reason: LocationFailureReason): string {
  switch (reason) {
    case "denied":
      return "Location permission is denied — type a place instead, or allow location in your device settings and try again.";
    case "disabled":
      return "Location services are off — turn them on and try again, or type a place instead.";
    case "timeout":
      return "Could not get a location within 8 seconds — try again, or type a place instead.";
    case "unsupported":
      return "Location is not supported in this browser — type a place instead.";
    case "unavailable":
    default:
      return "Location is unavailable right now — type a place instead, or try again.";
  }
}

/**
 * Resolves platform failures to `granted`/`denied`/failure reasons without
 * ever throwing, so a broken WebView degrades to a typed error message.
 */
export function requestOneTimeLocation(
  geolocation?: Geolocation | null,
): Promise<LocationOutcome> {
  // A second tap while one is still out returns the very same promise, so the
  // platform is never asked twice for one gesture burst.
  if (inFlight) return inFlight;

  const target =
    geolocation === undefined
      ? typeof navigator === "undefined"
        ? null
        : (navigator.geolocation ?? null)
      : geolocation;

  if (!target || typeof target.getCurrentPosition !== "function") {
    return Promise.resolve({ status: "unsupported" });
  }

  let resolveOutcome!: (outcome: LocationOutcome) => void;
  const pending = new Promise<LocationOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  inFlight = pending;
  // Release the lock at settle time, before any awaiting caller runs, so the
  // next explicit gesture may prompt again.
  const settle = (outcome: LocationOutcome) => {
    if (inFlight === pending) inFlight = null;
    resolveOutcome(outcome);
  };

  try {
    target.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        settle({
          status: "granted",
          latitude: Number(latitude.toFixed(6)),
          longitude: Number(longitude.toFixed(6)),
          accuracyMeters: Number.isFinite(accuracy) ? accuracy : null,
        });
      },
      (error: unknown) => {
        settle({ status: classifyGeolocationError(error) });
      },
      COARSE_LOCATION_OPTIONS,
    );
  } catch {
    // Some WebViews throw synchronously instead of calling the error path.
    settle({ status: "unavailable" });
  }

  return pending;
}
