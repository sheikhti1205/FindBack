/**
 * Testable seam over the official `@capacitor/google-maps` plugin.
 *
 * Components NEVER import the plugin directly: they go through
 * {@link createNativeMap}, which takes an injectable loader so unit tests can
 * drive a fake handle while the device verifies the real plugin. The draft /
 * commit / GPS / search logic in the components stays renderer-agnostic —
 * this seam only moves cameras/markers and reports user picks.
 *
 * Lifecycle contract (enforced by callers, provided here):
 * - `destroy()` is always called when the owning surface unmounts/closes, so
 *   the native view is torn down (no leaked maps across sheet reopens).
 * - Camera-idle callbacks are gated by the caller (see MapPickerSheet): the
 *   seam reports every idle; the caller decides which ones may move the draft.
 */

import type { MapCenter } from "./mapPickerState";

export interface NativeMapPick {
  center: MapCenter;
}

export interface NativeMapHandle {
  /** Add-or-move the single picker marker (remove + re-add under the hood). */
  setMarker(center: MapCenter): Promise<void>;
  /** Move the camera; `animate` eases unless the caller opts out. */
  setCamera(center: MapCenter, zoom?: number, animate?: boolean): Promise<void>;
  /** Map tap: the caller moves the marker AND the draft to the tap point. */
  onMapTap(callback: (pick: NativeMapPick) => void): Promise<void>;
  /**
   * Marker drag-end: the native marker already sits at the drop point, so
   * the caller moves only the draft (re-adding would flicker).
   */
  onMarkerDragEnd(callback: (pick: NativeMapPick) => void): Promise<void>;
  /** Raw camera-idle reports (center + zoom); the caller gates draft writes. */
  onCameraIdle(callback: (center: MapCenter, zoom: number) => void): Promise<void>;
  /** Current camera zoom (tracked from idles when the platform omits a getter). */
  destroy(): Promise<void>;
}

export interface NativeMapLoader {
  create(
    element: HTMLElement,
    options: { apiKey: string; center: MapCenter; zoom: number; draggable?: boolean },
  ): Promise<NativeMapHandle>;
}

export interface CreateNativeMapOptions {
  apiKey: string;
  center: MapCenter;
  zoom: number;
  /** Picker marker moves under the user's finger; read-only maps pin it. */
  draggable?: boolean;
  /** Injectable transport (tests); defaults to the real plugin. */
  loader?: NativeMapLoader;
}

/**
 * Real loader: dynamic-imports the plugin so the JS bundle path only pays
 * for it when a key is configured (callers check
 * {@link isGoogleMapsConfigured} first and never call this without a key).
 */
export const defaultNativeMapLoader: NativeMapLoader = {
  async create(element, options): Promise<NativeMapHandle> {
    const { GoogleMap } = await import("@capacitor/google-maps");
    const map = await GoogleMap.create({
      id: `findback-map-${Date.now().toString(36)}`,
      element,
      apiKey: options.apiKey,
      config: {
        center: { lat: options.center.lat, lng: options.center.lng },
        zoom: options.zoom,
      },
    });
    let markerId: string | null = null;
    return {
      async setMarker(center: MapCenter): Promise<void> {
        if (markerId != null) {
          try {
            await map.removeMarker(markerId);
          } catch {
            // A stale id (e.g. after a native-side clear) must not block
            // the replacement marker.
          }
          markerId = null;
        }
        markerId = await map.addMarker({
          coordinate: { lat: center.lat, lng: center.lng },
          draggable: options.draggable === true,
        });
      },
      async setCamera(center: MapCenter, zoom?: number, animate = true): Promise<void> {
        await map.setCamera({
          coordinate: { lat: center.lat, lng: center.lng },
          ...(zoom == null ? {} : { zoom }),
          animate,
        });
      },
      async onMapTap(callback: (pick: NativeMapPick) => void): Promise<void> {
        await map.setOnMapClickListener((event) => {
          callback({ center: { lat: event.latitude, lng: event.longitude } });
        });
      },
      async onMarkerDragEnd(callback: (pick: NativeMapPick) => void): Promise<void> {
        await map.setOnMarkerDragEndListener((event) => {
          callback({ center: { lat: event.latitude, lng: event.longitude } });
        });
      },
      async onCameraIdle(callback: (center: MapCenter, zoom: number) => void): Promise<void> {
        await map.setOnCameraIdleListener((event) => {
          callback({ lat: event.latitude, lng: event.longitude }, event.zoom);
        });
      },
      async destroy(): Promise<void> {
        markerId = null;
        await map.destroy();
      },
    };
  },
};

/**
 * Create one native map bound to `element`.
 * Throws when `apiKey` is empty — callers fail closed BEFORE this point and
 * surface consumer copy instead; this throw is a last-resort invariant.
 */
export async function createNativeMap(
  element: HTMLElement,
  options: CreateNativeMapOptions,
): Promise<NativeMapHandle> {
  if (!options.apiKey.trim()) {
    throw new Error("Google Maps API key is missing.");
  }
  return (options.loader ?? defaultNativeMapLoader).create(element, options);
}
