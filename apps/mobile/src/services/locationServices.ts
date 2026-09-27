import { Capacitor, registerPlugin } from "@capacitor/core";

interface NativeLocationServices {
  isLocationEnabled(): Promise<{ enabled: boolean }>;
  requestEnableLocation(): Promise<{ enabled: boolean }>;
}

function nativeBridge(): NativeLocationServices | null {
  try {
    if (!Capacitor.isNativePlatform()) return null;
    return registerPlugin<NativeLocationServices>("LocationServices");
  } catch {
    return null;
  }
}

/** True on a native build where the LocationServices plugin can exist. */
export function isNativeLocationServicesAvailable(): boolean {
  return nativeBridge() !== null;
}

/**
 * Read-only device Location-services switch. Returns null when unknown
 * (web, missing plugin, bridge error) so callers fall back to attempting a
 * fix rather than blocking on a signal they cannot read. Never prompts.
 */
export async function isDeviceLocationEnabled(): Promise<boolean | null> {
  const bridge = nativeBridge();
  if (!bridge) return null;
  try {
    const result = await bridge.isLocationEnabled();
    return result?.enabled ?? null;
  } catch {
    return null;
  }
}

/**
 * Presents Android's own enable-location dialog. User-controlled: dismissal
 * resolves false and the caller keeps the typed-place / manual-map fallback.
 * Returns false off-device or when the bridge is unavailable.
 */
export async function requestEnableDeviceLocation(): Promise<boolean> {
  const bridge = nativeBridge();
  if (!bridge) return false;
  try {
    const result = await bridge.requestEnableLocation();
    return result?.enabled === true;
  } catch {
    return false;
  }
}
