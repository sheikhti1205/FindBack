/** Device-local read-only principal roles. No wallpaper bytes, persistence or semantics. */
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { COLOR_SYSTEM, accentTokensFor, type PrincipalColors } from "../design/colorSystem";
import { withTimeout } from "./timeout";

export interface SystemColorsSnapshot {
  supported: boolean;
  palette: { light: PrincipalColors; dark: PrincipalColors } | null;
}
interface NativeSystemColors {
  getColors(): Promise<unknown>;
  addListener(event: "colorsChanged", listener: () => void): Promise<PluginListenerHandle>;
}
let bridge: NativeSystemColors | undefined;
let snapshot: SystemColorsSnapshot = { supported: false, palette: null };
let revision = 0;
const listeners = new Set<() => void>();
const isAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
const native = () => bridge ??= registerPlugin<NativeSystemColors>("FindbackSystemColors");
export const getSystemColorsSnapshot = () => snapshot;
export const systemColorsSupported = () => snapshot.supported;
export function subscribeSystemColors(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function hex(value: unknown): value is string { return typeof value === "string" && /^#[\da-f]{6}$/i.test(value); }
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}
function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function stateBackground(base: string, rgba: string): string {
  const channels = rgba.match(/^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/)!;
  const alpha = Number(channels[4]);
  return "#" + [1, 3, 5].map((start, i) => Math.round(parseInt(base.slice(start, start + 2), 16) * (1 - alpha)
    + Number(channels[i + 1]) * alpha).toString(16).padStart(2, "0")).join("");
}

/** Reject unsafe role groups against ACTUAL canonical surfaces, never stored hex. */
export function safeSystemRoles(input: unknown, mode: "light" | "dark"): PrincipalColors {
  const raw = record(input) ?? {};
  const fallback = accentTokensFor(COLOR_SYSTEM.defaultAccent, mode);
  const modes = mode === "light" ? [COLOR_SYSTEM.neutrals.light] : [COLOR_SYSTEM.neutrals.dark, COLOR_SYSTEM.neutrals.amoled];
  const surfaces = modes.flatMap(n => [n.surface, n.low, n.container, n.high]);
  const primarySafe = hex(raw.primary) && hex(raw.onPrimary)
    && contrast(raw.primary, raw.onPrimary) >= 4.5
    && surfaces.every(s => contrast(raw.primary as string, s) >= 3)
    && modes.every(n => [n.hover, n.pressed].every(layer => contrast(stateBackground(raw.primary as string, layer), raw.onPrimary as string) >= 4.5));
  const containerSafe = hex(raw.primaryContainer) && hex(raw.onPrimaryContainer)
    && contrast(raw.primaryContainer, raw.onPrimaryContainer) >= 4.5;
  const linkSafe = hex(raw.link) && surfaces.every(s => contrast(raw.link as string, s) >= 4.5);
  return {
    primary: primarySafe ? raw.primary as string : fallback.primary,
    onPrimary: primarySafe ? raw.onPrimary as string : fallback.onPrimary,
    primaryContainer: containerSafe ? raw.primaryContainer as string : fallback.primaryContainer,
    onPrimaryContainer: containerSafe ? raw.onPrimaryContainer as string : fallback.onPrimaryContainer,
    link: linkSafe ? raw.link as string : fallback.link,
  };
}

export async function refreshSystemColors(): Promise<SystemColorsSnapshot> {
  const request = ++revision;
  let next: SystemColorsSnapshot = { supported: false, palette: null };
  if (isAndroid()) {
    try {
      const raw = record(await withTimeout(() => native().getColors(), 3000, "System colors unavailable"));
      if (raw?.supported === true && record(raw.light) && record(raw.dark)) {
        next = { supported: true, palette: { light: safeSystemRoles(raw.light, "light"), dark: safeSystemRoles(raw.dark, "dark") } };
      }
    } catch { /* Old bridge/OS, timeout or resource error: truthful Blue fallback. */ }
  }
  if (request === revision) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
  return snapshot;
}

/** ThemeProvider owns this lifetime. Native emits on resume/configuration change. */
export function startSystemColorUpdates(): () => void {
  let live = true;
  let handle: PluginListenerHandle | undefined;
  const refresh = () => { if (live) void refreshSystemColors(); };
  refresh();
  if (isAndroid()) {
    void native().addListener("colorsChanged", refresh).then(h => {
      if (live) handle = h;
      else void h.remove().catch(() => undefined);
    }).catch(() => undefined);
  }
  return () => {
    live = false;
    revision++;
    void handle?.remove().catch(() => undefined);
  };
}
