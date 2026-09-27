import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";
import {
  COARSE_LOCATION_OPTIONS,
  formatAccuracy,
  isLowAccuracy,
  LOW_ACCURACY_METERS,
  requestOneTimeLocation,
  type LocationFailureReason,
} from "../components/locationPermission";
import { isDeviceLocationEnabled } from "./locationServices";

class LocationRequestError extends Error {
  constructor(readonly reason: LocationFailureReason) {
    super(reason);
  }
}

/**
 * Adapter interface for location providers. The production implementation
 * wraps the existing navigator.geolocation + locationPermission logic.
 * Tests inject a deterministic fake.
 */
export interface LocationAdapter {
  getCurrentPosition(options: PositionOptions): Promise<{
    latitude: number;
    longitude: number;
    accuracyMeters: number | null;
  }>;
  getPermission(): Promise<"granted" | "prompt" | "denied" | "unknown">;
  servicesEnabled?(): Promise<boolean | null>;
}

/**
 * State machine for a location fix request. Each state carries only the
 * data needed for the corresponding UI message.
 */
export type FixState =
  | { kind: "idle" }
  | { kind: "requesting-permission" }
  | { kind: "locating"; startedAt: number }
  | { kind: "fix"; lat: number; lng: number; accuracy: number | null }
  | {
      kind:
        | "denied"
        | "services-off"
        | "timeout"
        | "unavailable"
        | "unsupported";
      message: string;
    };

/**
 * User-facing microcopy for each failure kind. Exact strings from the
 * implementation packet — do not change without updating tests.
 */
export const FIX_MICROCOPY: Record<
  Exclude<FixState["kind"], "idle" | "requesting-permission" | "locating" | "fix">,
  string
> = {
  denied:
    "Location access is off for FindBack. Enable it in Settings, or choose a place on the map.",
  "services-off":
    "Device location is off. Turn it on or enter a place.",
  timeout:
    "We couldn't get a fix in time. Try again, choose on map, or enter a place.",
  unavailable:
    "Location is unavailable right now. Try again, choose on map, or enter a place.",
  unsupported:
    "Location is not supported in this browser. Choose a place on the map or enter coordinates.",
};

/** Shown once an approximate fix lands, before the user commits a pin. */
export const FIX_READY_COPY =
  "Approximate area selected. Review the public pin before posting.";

/** Shown when map tiles cannot load but a typed/pinned place is still saved. */
export const FIX_OFFLINE_MAP_COPY =
  "Map tiles are unavailable. Your typed place and coordinate choice are still saved.";

/**
 * "This estimate is around X m/km; review before using it." — the packet's
 * low-accuracy warning. Uses the shared accuracy formatter so the number
 * style stays consistent with the rest of the location UI.
 */
export function accuracyReviewMessage(accuracyMeters: number | null): string {
  return `This estimate is ${accuracyBand(accuracyMeters)}; review before using it.`;
}

/**
 * True when a fix is coarser than the published pin (~100 m) and therefore
 * requires an explicit "use anyway" before it can be committed.
 */
export function needsAccuracyReview(accuracyMeters: number | null): boolean {
  return isLowAccuracy(accuracyMeters);
}

/**
 * Returns true when the platform default is approximate (coarse) location.
 * On Android API 31+ the system may grant only approximate even when fine
 * permission is declared. The app explicitly requests coarse accuracy
 * (COARSE_LOCATION_OPTIONS has enableHighAccuracy: false), so unless the
 * caller opts into high accuracy the result is approximate by design.
 */
export function isApproximateDefault(options?: PositionOptions): boolean {
  return options?.enableHighAccuracy !== true;
}

/**
 * Formats an accuracy value into the "around X m/km" band used in the
 * low-accuracy warning. Delegates to the shared formatter so the number
 * style matches `locationPermission.formatAccuracy`.
 */
export function accuracyBand(accuracyMeters: number | null): string {
  if (accuracyMeters == null || !Number.isFinite(accuracyMeters)) {
    return "around a few km";
  }
  return `around ${formatAccuracy(accuracyMeters).replace(/^~/, "")}`;
}

export { LOW_ACCURACY_METERS };

/**
 * Maps a Capacitor Geolocation failure to the adapter's failure taxonomy.
 * "Location unavailable" on Android means the providers cannot produce a
 * fix — most commonly device Location services switched off — so it maps
 * to "disabled" (services-off), never to a generic timeout.
 */
export function mapNativeGeolocationError(err: unknown): LocationFailureReason {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const lower = message.toLowerCase();
  if (lower.includes("denied") || lower.includes("not authorized") || lower.includes("permission")) {
    return "denied";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  if (
    lower.includes("unavailable") ||
    lower.includes("disabled") ||
    lower.includes("location is off") ||
    lower.includes("settings")
  ) {
    return "disabled";
  }
  return "unavailable";
}

/**
 * Production adapter backed by the Android fused provider (Capacitor
 * Geolocation) on native builds, and by the existing navigator.geolocation
 * + locationPermission logic on web. A permission query must never obtain a
 * fix: permission prompts are only allowed after an explicit user gesture
 * (the "Use my location once" tap that calls getCurrentPosition).
 */
export function createProductionLocationAdapter(): LocationAdapter {
  if (Capacitor.isNativePlatform()) {
    return {
      async getCurrentPosition(options: PositionOptions) {
        try {
          const position = await Geolocation.getCurrentPosition({
            enableHighAccuracy: options.enableHighAccuracy ?? false,
            timeout: options.timeout ?? COARSE_LOCATION_OPTIONS.timeout ?? 8000,
            maximumAge: 0,
          });
          return {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracyMeters: position.coords.accuracy ?? null,
          };
        } catch (err) {
          throw new LocationRequestError(mapNativeGeolocationError(err));
        }
      },

      async getPermission() {
        try {
          const status = await Geolocation.checkPermissions();
          // checkPermissions is read-only; requesting happens inside
          // getCurrentPosition after the user's tap.
          if (status.coarseLocation === "denied" && status.location === "denied") return "denied";
          if (status.coarseLocation === "granted" || status.location === "granted") return "granted";
          return "prompt";
        } catch {
          return "prompt";
        }
      },

      async servicesEnabled() {
        // Device switch readable natively; null (unknown) falls back to
        // attempting a fix, same as the web path.
        return isDeviceLocationEnabled();
      },
    };
  }
  return {
    async getCurrentPosition(_options: PositionOptions) {
      // The shared facade owns coarse options, timeout and double-tap collapse.
      const outcome = await requestOneTimeLocation();
      if (outcome.status !== "granted") {
        throw new LocationRequestError(outcome.status);
      }
      return {
        latitude: outcome.latitude,
        longitude: outcome.longitude,
        accuracyMeters: outcome.accuracyMeters,
      };
    },

    async getPermission() {
      if (typeof navigator === "undefined" || !navigator.geolocation?.getCurrentPosition) {
        return "unknown";
      }
      // Permissions.query is read-only. Unsupported APIs / WebViews may still
      // allow a one-shot location request, so defer to the user's tap.
      if (!navigator.permissions?.query) return "prompt";
      try {
        const status = await navigator.permissions.query({ name: "geolocation" });
        return status.state;
      } catch {
        return "prompt";
      }
    },

    async servicesEnabled() {
      // No direct Web API for this; the "disabled" error code from
      // getCurrentPosition is the practical signal. Return null to mean
      // "unknown" so callers fall back to trying a fix.
      return null;
    },
  };
}

/**
 * Options for requestFixWithGeneration.
 */
export interface RequestFixOptions {
  /** Milliseconds to wait for a fix before timing out. */
  timeoutMs?: number;
  /** PositionOptions passed to the adapter. */
  positionOptions?: PositionOptions;
  /** Called on each state transition for UI updates. */
  onStateChange?: (state: FixState) => void;
  /**
   * Optional external generation token. If provided, the function will
   * read this value at key await points and discard the result if the
   * value has changed since the request started. This allows callers
   * (e.g., React components) to bump a generation counter on unmount,
   * account switch, or new request, causing in-flight requests to
   * silently discard their results without promising cancellation.
   */
  generation?: { current: number } | (() => number);
}

/**
 * Requests a location fix with a monotonic generation token. If the
 * component unmounts, the account switches, or a new request starts
 * before the previous one settles, the generation is bumped and the
 * late callback is ignored. This does NOT cancel the underlying
 * getCurrentPosition (not abortable in all WebViews) — it only
 * prevents a stale result from updating state.
 *
 * Returns a promise that resolves with the final FixState (fix or a
 * failure kind). The onStateChange callback receives intermediate
 * states (requesting-permission, locating) and the final state.
 */
export async function requestFixWithGeneration(
  adapter: LocationAdapter,
  opts: RequestFixOptions = {},
): Promise<FixState> {
  const { timeoutMs = 8000, positionOptions, onStateChange, generation: externalGeneration } = opts;

  const currentGeneration = typeof externalGeneration === "function"
    ? externalGeneration()
    : (externalGeneration?.current ?? 0);

  function getGeneration(): number {
    if (externalGeneration) {
      return typeof externalGeneration === "function"
        ? externalGeneration()
        : externalGeneration.current;
    }
    return currentGeneration;
  }

  function emit(state: FixState) {
    if (currentGeneration === getGeneration()) {
      onStateChange?.(state);
    }
  }

  function checkGeneration(): boolean {
    return currentGeneration === getGeneration();
  }

  // Start: requesting permission
  emit({ kind: "requesting-permission" });

  // Check permission first
  let permission: Awaited<ReturnType<LocationAdapter["getPermission"]>>;
  try {
    permission = await adapter.getPermission();
  } catch {
    permission = "prompt";
  }
  if (!checkGeneration()) return { kind: "idle" } as FixState;
  if (permission === "denied") {
    const state: FixState = { kind: "denied", message: FIX_MICROCOPY.denied };
    emit(state);
    return state;
  }
  if (permission === "unknown") {
    const state: FixState = { kind: "unsupported", message: FIX_MICROCOPY.unsupported };
    emit(state);
    return state;
  }

  // Check services if available
  if (adapter.servicesEnabled) {
    let servicesOn: boolean | null;
    try {
      servicesOn = await adapter.servicesEnabled();
    } catch {
      servicesOn = null;
    }
    if (!checkGeneration()) return { kind: "idle" } as FixState;
    if (servicesOn === false) {
      const state: FixState = { kind: "services-off", message: FIX_MICROCOPY["services-off"] };
      emit(state);
      return state;
    }
  }

  // Locating phase
  const startedAt = Date.now();
  emit({ kind: "locating", startedAt });

  try {
    const positionPromise = adapter.getCurrentPosition(
      positionOptions ?? COARSE_LOCATION_OPTIONS,
    );

    // Race with timeout. The timer is always cleared so a settled request
    // never leaves a stray timer running or rejects a handled promise.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });

    let result: Awaited<ReturnType<LocationAdapter["getCurrentPosition"]>>;
    try {
      result = await Promise.race([positionPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

    // If generation changed while we waited, discard this result
    if (!checkGeneration()) {
      return { kind: "idle" } as FixState;
    }

    const state: FixState = {
      kind: "fix",
      lat: result.latitude,
      lng: result.longitude,
      accuracy: result.accuracyMeters,
    };
    emit(state);
    return state;
  } catch (err) {
    // If generation changed, the error is stale
    if (!checkGeneration()) {
      return { kind: "idle" } as FixState;
    }

    const kind = err instanceof LocationRequestError
      ? err.reason === "disabled" ? "services-off" : err.reason
      : err instanceof Error && err.message === "timeout" ? "timeout" : "unavailable";
    const state: FixState = { kind, message: FIX_MICROCOPY[kind] };
    emit(state);
    return state;
  }
}
