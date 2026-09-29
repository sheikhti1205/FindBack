/**
 * Quick Appearance settings (AI-011).
 *
 * Single owner for the appearance controls rendered by AppearancePanel:
 * accent color, text scale (root font size), reduce-motion user override, and
 * the high-quality-photo flag. Everything applies to `document.documentElement`
 * and persists to localStorage immediately — there is no Save step.
 *
 * Layering notes:
 * - The OS reduced-motion preference stays the base signal. `reduceMotion`
 *   `"system"` defers to it; `"reduce"`/`"full"` override it. Imperative
 *   animation code should read `effectiveReduceMotion()` (or
 *   `resolveReduceMotion()` with an injected OS value in tests) instead of
 *   going straight to matchMedia. `uiMotion.shouldReduceMotion()` is NOT
 *   touched here — see the interface proposal in the handoff.
 * - `services/image.ts` is NOT touched here either. It keeps its fixed
 *   0.82 encode qualities; upload call sites should switch to
 *   `currentPhotoQuality()` (or `photoQualityFor(flag)`) when they are ready
 *   to honor the persisted High Quality Photo toggle.
 */

import { useCallback, useEffect, useState } from "react";

export const APPEARANCE_STORAGE_KEY = "findback.appearance.v1";

/** Window event fired on every save so other tabs/mounts re-apply. */
export const APPEARANCE_EVENT = "findback:appearance";

export type AccentId = "ink" | "blue" | "green" | "plum" | "clay";

export interface AccentOption {
  id: AccentId;
  label: string;
  /** Accent surface, applied as `--fb-accent`. */
  swatch: string;
  /** Label/icon color used on top of the swatch, applied as `--fb-accent-ink`. */
  onAccent: string;
}

/** Curated set — small on purpose; every swatch keeps AA vs its onAccent. */
export const ACCENT_OPTIONS: readonly AccentOption[] = [
  { id: "ink", label: "Ink", swatch: "#1a1a1a", onAccent: "#ffffff" },
  { id: "blue", label: "Blue", swatch: "#0b57d0", onAccent: "#ffffff" },
  { id: "green", label: "Green", swatch: "#2e5b34", onAccent: "#ffffff" },
  { id: "plum", label: "Plum", swatch: "#7b2d8b", onAccent: "#ffffff" },
  { id: "clay", label: "Clay", swatch: "#b3402a", onAccent: "#ffffff" },
];

export type TextScaleId = "compact" | "standard" | "large" | "xlarge";

export interface TextScaleOption {
  id: TextScaleId;
  label: string;
  /** Root font-size percentage applied to `<html>` (1rem scales with it). */
  percent: number;
}

export const TEXT_SCALE_OPTIONS: readonly TextScaleOption[] = [
  { id: "compact", label: "Small", percent: 87.5 },
  { id: "standard", label: "Default", percent: 100 },
  { id: "large", label: "Large", percent: 112.5 },
  { id: "xlarge", label: "Extra large", percent: 125 },
];

/**
 * Reduce-motion override layered on the OS setting:
 * - `"system"` follows `prefers-reduced-motion`,
 * - `"reduce"` forces reduced motion,
 * - `"full"` forces full motion.
 */
export type ReduceMotionOverride = "system" | "reduce" | "full";

export const REDUCE_MOTION_OPTIONS: readonly {
  value: ReduceMotionOverride;
  label: string;
}[] = [
  { value: "system", label: "System" },
  { value: "reduce", label: "Reduce" },
  { value: "full", label: "Full" },
];

export interface AppearanceSettings {
  accent: AccentId;
  textScale: TextScaleId;
  reduceMotion: ReduceMotionOverride;
  highQualityPhoto: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  accent: "ink",
  textScale: "standard",
  reduceMotion: "system",
  highQualityPhoto: false,
};

function isAccentId(value: unknown): value is AccentId {
  return ACCENT_OPTIONS.some((a) => a.id === value);
}

function isTextScaleId(value: unknown): value is TextScaleId {
  return TEXT_SCALE_OPTIONS.some((t) => t.id === value);
}

function isReduceMotionOverride(value: unknown): value is ReduceMotionOverride {
  return value === "system" || value === "reduce" || value === "full";
}

export function loadAppearance(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const parsed = JSON.parse(raw) as Partial<AppearanceSettings>;
    return {
      accent: isAccentId(parsed.accent) ? parsed.accent : DEFAULT_APPEARANCE.accent,
      textScale: isTextScaleId(parsed.textScale)
        ? parsed.textScale
        : DEFAULT_APPEARANCE.textScale,
      reduceMotion: isReduceMotionOverride(parsed.reduceMotion)
        ? parsed.reduceMotion
        : DEFAULT_APPEARANCE.reduceMotion,
      highQualityPhoto:
        typeof parsed.highQualityPhoto === "boolean"
          ? parsed.highQualityPhoto
          : DEFAULT_APPEARANCE.highQualityPhoto,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(settings: AppearanceSettings): void {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore — private-mode storage just means "don't persist" */
  }
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT));
  }
}

/** True when the OS prefers reduced motion. Never throws (SSR/jsdom-safe). */
export function osPrefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Layer the user override on top of the OS setting. `osDefault` is injectable
 * so tests don't need matchMedia; callers pass nothing in production.
 */
export function resolveReduceMotion(
  override: ReduceMotionOverride,
  osDefault: boolean = osPrefersReducedMotion(),
): boolean {
  if (override === "reduce") return true;
  if (override === "full") return false;
  return osDefault;
}

/** Effective reduce-motion flag for the currently persisted settings. */
export function effectiveReduceMotion(
  settings: AppearanceSettings = loadAppearance(),
): boolean {
  return resolveReduceMotion(settings.reduceMotion);
}

/**
 * Apply settings to the document root: accent CSS vars, root font-size
 * scale, and a `fb-reduce-motion` class + `data-reduce-motion-override`
 * marker carrying the effective motion flag.
 */
export function applyAppearance(settings: AppearanceSettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const accent =
    ACCENT_OPTIONS.find((a) => a.id === settings.accent) ??
    ACCENT_OPTIONS.find((a) => a.id === DEFAULT_APPEARANCE.accent)!;
  const scale =
    TEXT_SCALE_OPTIONS.find((t) => t.id === settings.textScale) ??
    TEXT_SCALE_OPTIONS.find((t) => t.id === DEFAULT_APPEARANCE.textScale)!;
  root.style.setProperty("--fb-accent", accent.swatch);
  root.style.setProperty("--fb-accent-ink", accent.onAccent);
  root.style.fontSize = `${scale.percent}%`;
  root.dataset.reduceMotionOverride = settings.reduceMotion;
  root.classList.toggle("fb-reduce-motion", resolveReduceMotion(settings.reduceMotion));
}

/** Encode qualities mirroring `services/image.ts` (standard) plus a high tier. */
export const PHOTO_QUALITY_STANDARD = { jpeg: 0.82, webp: 0.82 } as const;
export const PHOTO_QUALITY_HIGH = { jpeg: 0.92, webp: 0.92 } as const;

export function photoQualityFor(highQuality: boolean): {
  readonly jpeg: number;
  readonly webp: number;
} {
  return highQuality ? PHOTO_QUALITY_HIGH : PHOTO_QUALITY_STANDARD;
}

/**
 * Quality tier for the currently persisted High Quality Photo flag.
 * Upload call sites in `services/image.ts` consumers should read this instead
 * of the fixed `JPEG_QUALITY`/`WEBP_QUALITY` constants when honoring the toggle.
 */
export function currentPhotoQuality(): {
  readonly jpeg: number;
  readonly webp: number;
} {
  return photoQualityFor(loadAppearance().highQualityPhoto);
}

export interface AppearanceApi {
  settings: AppearanceSettings;
  update: (patch: Partial<AppearanceSettings>) => void;
}

/**
 * Reactive appearance store: applies on mount/change and re-syncs when
 * another hook instance (or tab) saves. Every `update` applies + persists
 * synchronously — callers never Save.
 */
export function useAppearance(): AppearanceApi {
  const [settings, setSettings] = useState<AppearanceSettings>(loadAppearance);

  useEffect(() => {
    applyAppearance(settings);
  }, [settings]);

  useEffect(() => {
    const sync = () => setSettings(loadAppearance());
    window.addEventListener(APPEARANCE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(APPEARANCE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const update = useCallback((patch: Partial<AppearanceSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveAppearance(next);
      applyAppearance(next);
      return next;
    });
  }, []);

  return { settings, update };
}
