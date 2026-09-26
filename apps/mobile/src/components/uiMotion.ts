/**
 * Shared motion tokens (handover 04 motion policy, M2-motion).
 *
 * Single source of truth for durations/easings — no per-screen hardcoded
 * animation values. Structural transitions (sheet enter/exit, backdrop fade)
 * use framer-motion, which is already gated app-wide by
 * `<MotionConfig reducedMotion="user">` in App.tsx. `shouldReduceMotion()`
 * is the escape hatch for custom JS-driven effects (none in the shell today):
 * when it returns true, skip the animation and apply the end state.
 *
 * Duration budget (seconds): instant ~80–120ms state acknowledgement,
 * fast ~120–180ms chip/icon toggle, standard ~180–240ms notice/subpanel,
 * sheet ~220–320ms entrance/exit with clean interruption. Nothing ordinary
 * exceeds 350ms.
 */

export const motionDurations = {
  /** State acknowledgement (pressed/selected). */
  instant: 0.1,
  /** Chip/icon toggles, backdrop fade. */
  fast: 0.15,
  /** Notices, sheet subpanels. */
  standard: 0.22,
  /** Sheet entrance/exit (interruption-safe). */
  sheet: 0.28,
} as const;

export const motionEasings = {
  /** Standard ease-out — matches `--ease-fb` in index.css. */
  out: [0.2, 0, 0, 1] as [number, number, number, number],
  /** Gentle ease-in-out for fades. */
  inOut: [0.4, 0, 0.2, 1] as [number, number, number, number],
} as const;

/** Sheet slide transition (enter + exit, tween for clean interruption). */
export const sheetTransition = {
  type: "tween",
  duration: motionDurations.sheet,
  ease: motionEasings.out,
} as const;

/** Backdrop opacity fade (faster than the sheet travel). */
export const backdropTransition = {
  type: "tween",
  duration: motionDurations.fast,
  ease: "easeOut",
} as const;

/**
 * True when the device prefers reduced motion. Never throws (SSR/jsdom
 * without matchMedia → false, i.e. full motion).
 */
export function shouldReduceMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
