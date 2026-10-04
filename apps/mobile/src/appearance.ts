/**
 * Quick Appearance settings (AI-011).
 *
 * Single owner for the appearance controls (now rendered by the Settings →
 * Appearance screen; the legacy AppearancePanel was removed):
 * accent color, text scale (root font size), reduce-motion user override, and
 * the high-quality-photo flag. Everything applies to `document.documentElement`
 * and persists to localStorage immediately — there is no Save step.
 *
 * Layering notes:
 * - The OS reduced-motion preference stays the base signal. `reduceMotion`
 *   `"system"` defers to it; `"reduce"`/`"full"` override it. The effective
 *   flag (`resolveReduceMotion` / `effectiveReduceMotion`) is the single
 *   authority: `uiMotion.shouldReduceMotion()` / `useShouldReduceMotion()`,
 *   the App `MotionConfig` mapping (`motionConfigValueFor`), and the
 *   `fb-reduce-motion` CSS class all consume it, so runtime changes apply
 *   without reload. Imperative animation code must read the uiMotion helpers
 *   (never matchMedia directly). Functional gesture tracking stays enabled
 *   when reduced motion is on — only travel/animation collapses to instant.
 * - `services/image.ts` honors the High Quality Photo flag via
 *   `currentPhotoQuality()` (default encode tier, overridable per call);
 *   `services/media/importImage.ts` takes an explicit `highQuality` input and
 *   starts its adaptive ladder at the high tier while keeping every byte and
 *   dimension cap hard.
 * - Accent pairs are emitted for both light and dark so CSS can select the
 *   active palette without a stale inline color during an OS/theme change.
 *   Lost/Found/Error/Warning/Success remain independent semantic roles.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export const APPEARANCE_STORAGE_KEY = "findback.appearance.v1";

/** Window event fired on every save so other tabs/mounts re-apply. */
export const APPEARANCE_EVENT = "findback:appearance";

export type AccentId = "emerald" | "blue" | "violet" | "rose" | "amber" | "teal" | "mono";

export interface AccentOption {
  id: AccentId;
  label: string;
  /** Accent surface, applied as `--fb-accent`. */
  swatch: string;
  /** Label/icon color used on top of the swatch, applied as `--fb-accent-ink`. */
  onAccent: string;
  darkSwatch: string;
  darkOnAccent: string;
  container: string;
  darkContainer: string;
}

/** Curated set — small on purpose; every swatch keeps AA vs its onAccent. */
export const ACCENT_OPTIONS: readonly AccentOption[] = [
  { id: "emerald", label: "Emerald", swatch: "#256c4a", onAccent: "#ffffff", darkSwatch: "#82d5aa", darkOnAccent: "#00391e", container: "#e1f2e8", darkContainer: "#153c29" },
  { id: "blue", label: "Blue", swatch: "#3568d4", onAccent: "#ffffff", darkSwatch: "#adc7ff", darkOnAccent: "#082b60", container: "#e8eeff", darkContainer: "#1c355c" },
  { id: "violet", label: "Violet", swatch: "#7355b7", onAccent: "#ffffff", darkSwatch: "#cfbdff", darkOnAccent: "#2e1a61", container: "#f0eaff", darkContainer: "#38285c" },
  { id: "rose", label: "Rose", swatch: "#a34763", onAccent: "#ffffff", darkSwatch: "#ffb2c4", darkOnAccent: "#5b112b", container: "#fbe8ef", darkContainer: "#51283a" },
  { id: "amber", label: "Amber", swatch: "#7a5700", onAccent: "#ffffff", darkSwatch: "#e9c46a", darkOnAccent: "#3d2d00", container: "#f8edce", darkContainer: "#46391c" },
  { id: "teal", label: "Teal", swatch: "#006a6a", onAccent: "#ffffff", darkSwatch: "#7bd8d8", darkOnAccent: "#003838", container: "#ddf2f1", darkContainer: "#153c3c" },
  { id: "mono", label: "Mono", swatch: "#1a1a1a", onAccent: "#ffffff", darkSwatch: "#e6e6e0", darkOnAccent: "#121212", container: "#e9ece7", darkContainer: "#333632" },
];

/** Accepts old IDs only at the persistence boundary; UI always uses new IDs. */
export function migrateAccent(value: unknown): AccentId {
  if (isAccentId(value)) return value;
  const legacy: Record<string, AccentId> = { ink: "mono", green: "emerald", plum: "violet", clay: "rose" };
  return typeof value === "string" && Object.hasOwn(legacy, value)
    ? legacy[value]!
    : DEFAULT_APPEARANCE.accent;
}

export function accentTokensFor(id: AccentId, mode: "light" | "dark" | "amoled") {
  const accent = ACCENT_OPTIONS.find((a) => a.id === id) ?? ACCENT_OPTIONS[0]!;
  const dark = mode !== "light";
  return {
    primary: dark ? accent.darkSwatch : accent.swatch,
    onPrimary: dark ? accent.darkOnAccent : accent.onAccent,
    primaryContainer: dark ? accent.darkContainer : accent.container,
    onPrimaryContainer: dark ? accent.darkSwatch : accent.darkOnAccent,
    link: dark ? accent.darkSwatch : accent.darkOnAccent,
  };
}

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
  accent: "emerald",
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

/** Pure field-by-field migration; malformed fields never discard valid peers. */
export function migrateAppearance(value: unknown): AppearanceSettings {
  const parsed = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<AppearanceSettings>
    : {};
  return {
    accent: migrateAccent(parsed.accent),
    textScale: isTextScaleId(parsed.textScale) ? parsed.textScale : DEFAULT_APPEARANCE.textScale,
    reduceMotion: isReduceMotionOverride(parsed.reduceMotion) ? parsed.reduceMotion : DEFAULT_APPEARANCE.reduceMotion,
    highQualityPhoto: typeof parsed.highQualityPhoto === "boolean" ? parsed.highQualityPhoto : DEFAULT_APPEARANCE.highQualityPhoto,
  };
}

export function loadAppearance(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    return migrateAppearance(JSON.parse(raw));
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
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: settings }));
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
 * Framer Motion `reducedMotion` prop for the persisted override:
 * - `"reduce"` forces reduced motion → `"always"`,
 * - `"full"` forces full motion → `"never"`,
 * - `"system"` defers to the OS → `"user"`.
 * Pure mapping so the OS×override matrix is unit-testable; App.tsx applies it
 * reactively (no reload) via `useAppearance()`.
 */
export function motionConfigValueFor(
  override: ReduceMotionOverride,
): "always" | "never" | "user" {
  if (override === "reduce") return "always";
  if (override === "full") return "never";
  return "user";
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
  for (const mode of ["light", "dark"] as const) {
    const tokens = accentTokensFor(accent.id, mode);
    root.style.setProperty(`--fb-primary-${mode}`, tokens.primary);
    root.style.setProperty(`--fb-on-primary-${mode}`, tokens.onPrimary);
    root.style.setProperty(`--fb-primary-container-${mode}`, tokens.primaryContainer);
    root.style.setProperty(`--fb-on-primary-container-${mode}`, tokens.onPrimaryContainer);
    root.style.setProperty(`--fb-link-${mode}`, tokens.link);
  }
  root.style.setProperty("--fb-accent", "var(--fb-primary)");
  root.style.setProperty("--fb-accent-ink", "var(--fb-on-primary)");
  root.dataset.accent = accent.id;
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
 * `services/image.ts` reads this by default on every normalize; explicit
 * tiers can still be passed per call (tests, special flows).
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
  const current = useRef(settings);

  useEffect(() => {
    applyAppearance(settings);
  }, [settings]);

  useEffect(() => {
    const sync = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== APPEARANCE_STORAGE_KEY && event.key !== null) return;
      const next = event instanceof CustomEvent && event.detail
        ? migrateAppearance(event.detail) : loadAppearance();
      current.current = next;
      setSettings(next);
    };
    window.addEventListener(APPEARANCE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(APPEARANCE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const update = useCallback((patch: Partial<AppearanceSettings>) => {
    const next = migrateAppearance({ ...current.current, ...patch });
    current.current = next;
    setSettings(next);
    applyAppearance(next);
    saveAppearance(next);
  }, []);

  return { settings, update };
}
