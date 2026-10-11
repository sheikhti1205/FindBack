/**
 * FindbackMap native bridge facade (keyless MAP pivot).
 *
 * The native side is `FindbackMapPlugin` (MapLibre Native Activity +
 * snapshotter). This module is the only JS surface the map screens touch.
 *
 * Fail-closed rules:
 * - off Android (or bridge missing) every call rejects with a stable
 *   `FindbackMapError` code — callers fall back to the raster map, search,
 *   and manual coordinates; the map never hard-fails a report,
 * - malformed native results are rejected, never committed,
 * - native errors surface with our own stable, consumer-safe message — never
 *   raw platform text,
 * - there is no map secret: this facade has no key parameter at all.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

export type MapFailureCode =
  | "unavailable"
  | "busy"
  | "invalid-coordinates"
  | "invalid-result"
  | "failed";

const CODE_FOR_MESSAGE: Record<MapFailureCode, string> = {
  unavailable: "MAP_UNAVAILABLE",
  busy: "MAP_PICKER_BUSY",
  "invalid-coordinates": "MAP_INVALID_COORDINATES",
  "invalid-result": "MAP_INVALID_RESULT",
  failed: "MAP_FAILED",
};

export class FindbackMapError extends Error {
  readonly code: string;
  constructor(kind: MapFailureCode) {
    super(
      kind === "unavailable"
        ? "The map is not available on this device."
        : kind === "busy"
          ? "The location picker is already open."
          : kind === "invalid-coordinates"
            ? "A map needs valid coordinates."
            : kind === "invalid-result"
              ? "The map returned an invalid result."
              : "The map failed.",
    );
    this.name = "FindbackMapError";
    this.code = CODE_FOR_MESSAGE[kind];
  }
}

/** Map a native rejection code to the stable facade taxonomy. */
function fromNativeCode(code: unknown): MapFailureCode {
  if (typeof code !== "string") return "failed";
  if (code === "MAP_PICKER_BUSY") return "busy";
  if (code === "MAP_INVALID_COORDINATES") return "invalid-coordinates";
  return "failed";
}

export interface MapCapabilities {
  native: boolean;
  renderer: string;
  rendererVersion: string;
  styleProvider: string;
  snapshot: boolean;
  picker: boolean;
}

export interface MapPickerInput {
  latitude?: number;
  longitude?: number;
  zoom?: number;
  label?: string;
  allowCurrentLocation?: boolean;
}

export type MapPickerResult =
  | { cancelled: true }
  | { cancelled: false; latitude: number; longitude: number; zoom: number };

export interface MapViewerInput {
  latitude: number;
  longitude: number;
  zoom?: number;
  label?: string;
}

export interface MapSnapshotInput {
  latitude: number;
  longitude: number;
  zoom?: number;
  width: number;
  height: number;
  theme?: "light" | "dark" | "amoled";
}

export interface MapSnapshotResult {
  uri: string;
  width: number;
  height: number;
  cacheKey: string;
}

interface NativeFindbackMap {
  getCapabilities(): Promise<MapCapabilities>;
  openPicker(options: {
    latitude?: number;
    longitude?: number;
    zoom?: number;
    label?: string;
    allowCurrentLocation?: boolean;
  }): Promise<MapPickerResult>;
  openViewer(options: { latitude: number; longitude: number; zoom?: number; label?: string }): Promise<{
    closed: boolean;
  }>;
  renderSnapshot(options: {
    latitude: number;
    longitude: number;
    zoom?: number;
    width: number;
    height: number;
    theme?: string;
  }): Promise<MapSnapshotResult>;
}

function nativeBridge(): NativeFindbackMap | null {
  try {
    if (!Capacitor.isNativePlatform()) return null;
    return registerPlugin<NativeFindbackMap>("FindbackMap");
  } catch {
    return null;
  }
}

/** True on a native build where the FindbackMap plugin can exist. */
export function isNativeMapPickerAvailable(): boolean {
  return nativeBridge() !== null;
}

function isValidCoordinate(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function sanitizePickerResult(result: unknown): MapPickerResult {
  if (result == null || typeof result !== "object") throw new FindbackMapError("invalid-result");
  const candidate = result as Partial<MapPickerResult & { latitude: unknown; longitude: unknown; zoom: unknown }>;
  if (candidate.cancelled === true) return { cancelled: true };
  if (candidate.cancelled !== false) throw new FindbackMapError("invalid-result");
  if (!isValidCoordinate(candidate.latitude, candidate.longitude)) {
    throw new FindbackMapError("invalid-result");
  }
  const zoom =
    typeof candidate.zoom === "number" && Number.isFinite(candidate.zoom)
      ? Math.min(20, Math.max(1, candidate.zoom))
      : 15;
  return {
    cancelled: false,
    latitude: candidate.latitude as number,
    longitude: candidate.longitude as number,
    zoom,
  };
}

/**
 * Open the native MapLibre picker. Resolves `{cancelled:true}` on cancel —
 * the caller must not mutate the draft in that case. Rejects with
 * {@link FindbackMapError} (never a raw platform error).
 */
export async function openMapPickerNative(input: MapPickerInput): Promise<MapPickerResult> {
  const bridge = nativeBridge();
  if (!bridge) throw new FindbackMapError("unavailable");
  let raw: MapPickerResult;
  try {
    raw = await bridge.openPicker({
      latitude: input.latitude,
      longitude: input.longitude,
      zoom: input.zoom,
      label: input.label,
      allowCurrentLocation: input.allowCurrentLocation ?? true,
    });
  } catch (err) {
    throw new FindbackMapError(fromNativeCode((err as { code?: unknown } | null)?.code));
  }
  return sanitizePickerResult(raw);
}

/** Open the read-only native viewer for committed coordinates. */
export async function openMapViewerNative(input: MapViewerInput): Promise<{ closed: boolean }> {
  if (!isValidCoordinate(input.latitude, input.longitude)) {
    throw new FindbackMapError("invalid-coordinates");
  }
  const bridge = nativeBridge();
  if (!bridge) throw new FindbackMapError("unavailable");
  try {
    await bridge.openViewer({
      latitude: input.latitude,
      longitude: input.longitude,
      zoom: input.zoom,
      label: input.label,
    });
    return { closed: true };
  } catch (err) {
    throw new FindbackMapError(fromNativeCode((err as { code?: unknown } | null)?.code));
  }
}

/** Capabilities probe — null off-device (the caller uses the fallback). */
export async function getMapCapabilities(): Promise<MapCapabilities | null> {
  const bridge = nativeBridge();
  if (!bridge) return null;
  try {
    return await bridge.getCapabilities();
  } catch {
    return null;
  }
}

/** Snapshot output caps (mirror the native clamp: max 1024 px per side). */
export const MAP_SNAPSHOT_MAX_EDGE_PX = 1024;
export const MAP_SNAPSHOT_MIN_EDGE_PX = 64;

function clampEdge(px: number): number {
  if (!Number.isFinite(px)) return MAP_SNAPSHOT_MIN_EDGE_PX;
  return Math.min(MAP_SNAPSHOT_MAX_EDGE_PX, Math.max(MAP_SNAPSHOT_MIN_EDGE_PX, Math.round(px)));
}

/**
 * Render a post-detail map preview through the native snapshotter. Rejects
 * with {@link FindbackMapError} on invalid input, missing bridge, malformed
 * payloads, or native failure — the caller shows the truthful fallback.
 */
export async function renderMapSnapshotNative(input: MapSnapshotInput): Promise<MapSnapshotResult> {
  if (!isValidCoordinate(input.latitude, input.longitude)) {
    throw new FindbackMapError("invalid-coordinates");
  }
  const bridge = nativeBridge();
  if (!bridge) throw new FindbackMapError("unavailable");
  let raw: unknown;
  try {
    raw = await bridge.renderSnapshot({
      latitude: input.latitude,
      longitude: input.longitude,
      zoom: input.zoom,
      width: clampEdge(input.width),
      height: clampEdge(input.height),
      theme: input.theme ?? "light",
    });
  } catch (err) {
    throw new FindbackMapError(fromNativeCode((err as { code?: unknown } | null)?.code));
  }
  const candidate = raw as Partial<MapSnapshotResult>;
  if (
    raw == null ||
    typeof raw !== "object" ||
    typeof candidate.uri !== "string" ||
    !candidate.uri.trim() ||
    typeof candidate.cacheKey !== "string" ||
    !candidate.cacheKey.trim()
  ) {
    throw new FindbackMapError("invalid-result");
  }
  return raw as MapSnapshotResult;
}
