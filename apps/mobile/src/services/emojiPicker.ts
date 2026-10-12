import { Capacitor } from "@capacitor/core";

/**
 * FBX-016 comment-composer emoji bridge (comments composer).
 *
 * - On Android the composer calls the native `FindbackEmoji` bottom-sheet
 *   picker (`pickNativeEmoji`) — the device-rendered sheet is the source of
 *   truth there, so the web set below is never treated as final and the two
 *   sets are deliberately never synced.
 * - Everywhere else (web fallback, or native unavailable/cancelled) the
 *   composer renders `EMOJI_WEB_FALLBACK` — a compact fallback-only grid
 *   clearly marked as such. The composer must not hardcode its own set.
 * - Bridge payloads are sanitized (`sanitizePickedEmoji`): a malformed
 *   native response can never inject arbitrary text/URLs into the draft.
 *   Picking never throws — cancel/failure resolves null.
 */

/**
 * Compact web-fallback grid (fallback ONLY — never the device set, never
 * final). The native bottom sheet owns emoji selection on Android; this list
 * exists so the web runtime still offers insertion without a vendor-keyboard
 * hack.
 */
export const EMOJI_WEB_FALLBACK: readonly string[] = [
  "😀", "😁", "😂", "🤣", "😊", "😍", "😘", "🥳",
  "😎", "🤔", "😅", "😭", "😡", "👍", "👎", "🙏",
  "👏", "🎉", "❤️", "🔥", "⭐", "👀", "🎁", "🌈",
  "⚽", "☕", "🍕", "🎂", "🍀", "🐶", "🐱", "🌸",
];

interface FindbackEmojiPlugin {
  pickEmoji(): Promise<{ emoji?: string } | { cancelled: true }>;
}

/**
 * Lazily bound bridge handle. `registerPlugin` is deliberately NOT called at
 * module scope: this module sits in the composer import graph, which loads
 * in suites that partially mock `@capacitor/core`, so touching the plugin
 * registry at load would break them. The availability gate runs first and
 * only the native pick path binds.
 */
let cachedPlugin: FindbackEmojiPlugin | null = null;

async function getPlugin(): Promise<FindbackEmojiPlugin | null> {
  if (cachedPlugin) return cachedPlugin;
  try {
    const { registerPlugin } = await import("@capacitor/core");
    cachedPlugin = registerPlugin<FindbackEmojiPlugin>("FindbackEmoji");
    return cachedPlugin;
  } catch {
    return null;
  }
}

/** True only in the Android app with the native emoji bridge registered. */
export function isNativeEmojiAvailable(): boolean {
  try {
    return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("FindbackEmoji");
  } catch {
    return false;
  }
}

/**
 * Validate a bridge payload. Accepts one visible emoji pick (including
 * multi-codepoint sequences — flags, skin tones, ZWJ families — hence the
 * generous length cap) and rejects everything else: blanks, whitespace
 * runs, URLs, data payloads. Pure and total: never throws.
 */
export function sanitizePickedEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 24) return null;
  if (/\s/.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  if (/^data:/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Open the native bottom-sheet emoji picker. Resolves the picked emoji, or
 * null when native is unavailable, the user cancels, or the payload is
 * malformed. Never throws, never falls back silently — the caller decides
 * between this and `EMOJI_WEB_FALLBACK`.
 */
export async function pickNativeEmoji(): Promise<string | null> {
  if (!isNativeEmojiAvailable()) return null;
  try {
    const plugin = await getPlugin();
    if (!plugin) return null;
    const result = await plugin.pickEmoji();
    if (!result || "cancelled" in result) return null;
    return sanitizePickedEmoji((result as { emoji?: unknown }).emoji);
  } catch {
    return null;
  }
}
