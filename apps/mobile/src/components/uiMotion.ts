/**
 * Shared motion tokens (handover 04 motion policy, M2-motion, motion pass).
 *
 * Single source of truth for durations/springs/variants — no per-screen
 * hardcoded animation values.
 *
 * Reduced motion (owner decision 2026-09-28): the OS setting is honored.
 * `<MotionConfig reducedMotion="user">` at the app root is the single switch:
 * Framer Motion then degrades transform/layout travel to instant while keeping
 * opacity/color, so press feedback and fades still register but nothing
 * travels. Imperative, non-Motion work (scrollTo/scrollIntoView, MapLibre
 * camera, raw CSS transitions) cannot see MotionConfig — those call
 * `useShouldReduceMotion()` (components) or `shouldReduceMotion()` (plain
 * modules) and collapse their travel to instant.
 *
 * Duration budget (seconds): instant ~80–120ms state acknowledgement,
 * fast ~120–180ms chip/icon toggle, standard ~180–240ms notice/subpanel,
 * sheet ~220–320ms entrance/exit with clean interruption, emphasized
 * ~240–350ms hero/notice emphasis. Nothing ordinary exceeds 350ms.
 *
 * All variants below animate transform/opacity only (never layout, color, or
 * box-shadow) so every animation stays on the compositor thread.
 */

import { useReducedMotion } from "framer-motion";

export const motionDurations = {
  /** State acknowledgement (pressed/selected). */
  instant: 0.1,
  /** Chip/icon toggles, backdrop fade. */
  fast: 0.15,
  /** Notices, sheet subpanels. */
  standard: 0.22,
  /** Sheet entrance/exit (interruption-safe). */
  sheet: 0.28,
  /** Hero/notice emphasis (still within the 350ms budget). */
  emphasized: 0.3,
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
 * Shared springs — no per-screen hardcoded stiffness/damping.
 * Snappy drives the nav pill + segmented slide; soft drives larger travels.
 */
export const motionSprings = {
  /** Tight selection slide (nav pill, segmented control). */
  snappy: { type: "spring", stiffness: 420, damping: 36 },
  /** Gentler travel for larger elements (sheets, rails). */
  soft: { type: "spring", stiffness: 260, damping: 30 },
} as const;

/** Press feedback scales — same language for buttons and icon-buttons. */
export const pressFeedback = {
  /** Full buttons (Button.tsx). */
  button: { scale: 0.97 },
  /** Icon-only buttons (nav links, filter trigger, rail tools). */
  iconButton: { scale: 0.96 },
  /** Dense editor-rail tools. */
  rail: { scale: 0.92 },
} as const;

/** Plain opacity fade (toasts, labels). */
export const fadeVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
} as const;

/** Rise-and-fade for notices and labels. */
export const fadeUpVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 8 },
} as const;

/** Anchored pop-in for editor menus and small popovers. */
export const scaleInVariants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.96 },
} as const;

/** Anchored menu popover (slight rise plus scale). */
export const popoverVariants = {
  hidden: { opacity: 0, scale: 0.96, y: 4 },
  visible: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.96, y: 4 },
} as const;

/** Snackbar rise/fade with a settled visible state. */
export const snackbarVariants = {
  hidden: { opacity: 0, y: 16, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 8, scale: 0.98 },
} as const;

/** Route-level page fade (opacity only — never slides layout). */
export const pageVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
} as const;

/** Drill-down: detail enters from the trailing edge, content settles. */
export const pageForwardVariants = {
  hidden: { opacity: 0, x: 16 },
  visible: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -12 },
} as const;

/** Back navigation: the reverse of `pageForwardVariants`. */
export const pageBackwardVariants = {
  hidden: { opacity: 0, x: -16 },
  visible: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 12 },
} as const;

/** Small rise/fade for appended list rows and inline notices. */
export const listItemVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4 },
} as const;

/** Centered dialog/lightbox panel: slight scale + rise, never a slide. */
export const dialogVariants = {
  hidden: { opacity: 0, scale: 0.97, y: 8 },
  visible: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.97, y: 8 },
} as const;

/**
 * True when the device prefers reduced motion. Never throws (SSR/jsdom
 * without matchMedia → false, i.e. full motion).
 *
 * Imperative code (scrollTo, scrollIntoView, MapLibre camera, raw CSS
 * transitions) reads this. Motion components do NOT: `<MotionConfig
 * reducedMotion="user">` at the app root degrades them centrally.
 */
export function shouldReduceMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * React hook form of {@link shouldReduceMotion} for components driving
 * imperative animation (element.scrollTo, scrollIntoView, canvas/CSS work).
 * Re-renders when the OS preference changes.
 */
export function useShouldReduceMotion(): boolean {
  return useReducedMotion() ?? false;
}
