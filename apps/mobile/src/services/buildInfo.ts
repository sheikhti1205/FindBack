import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";

export interface BuildInfo {
  buildGitSha?: string;
  versionCode?: number;
}

/** Optional native bridge exposing the baked-in build SHA when present. */
interface NativeBuildInfoBridge {
  getBuildInfo(): Promise<{ buildGitSha?: string; versionCode?: number }>;
}

function sanitizeSha(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "unknown" ? trimmed : undefined;
}

function sanitizeVersionCode(value: unknown): number | undefined {
  const code = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof code === "number" && Number.isInteger(code) && code > 0 ? code : undefined;
}

/**
 * Cloud-first build identity. Returns the installed native build SHA and
 * versionCode when available, otherwise {}. VersionCode comes from the
 * Capacitor App info; the SHA comes from the optional native
 * `FindBackBuildInfo` bridge when a build provides it. Fails closed (never
 * throws): off-device or unreadable means {} and callers show "unknown".
 */
export async function readBuildInfo(): Promise<BuildInfo> {
  try {
    if (!Capacitor.isNativePlatform()) return {};
    const out: BuildInfo = {};
    try {
      const info = await CapacitorApp.getInfo();
      const versionCode = sanitizeVersionCode(info.build);
      if (versionCode !== undefined) out.versionCode = versionCode;
    } catch {
      // App info unreadable: still try the SHA bridge below.
    }
    try {
      const bridge = registerPlugin<NativeBuildInfoBridge>("FindBackBuildInfo");
      const native = await bridge.getBuildInfo();
      const sha = sanitizeSha(native?.buildGitSha);
      if (sha !== undefined) out.buildGitSha = sha;
      const versionCode = sanitizeVersionCode(native?.versionCode);
      if (versionCode !== undefined) out.versionCode = versionCode;
    } catch {
      // Optional bridge absent on this build: versionCode (when read) still stands.
    }
    return out;
  } catch {
    return {};
  }
}
