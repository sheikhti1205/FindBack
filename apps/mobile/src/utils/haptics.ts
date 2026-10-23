/**
 * The one haptic entry point for gesture feedback.
 *
 * "Where supported" is literal: the WebView may expose no vibration API, the
 * device may have haptics disabled, or the platform may ignore the request.
 * A missing pattern is never a user-visible failure and never blocks the
 * gesture; callers only use it as confirmation.
 */
export type HapticPattern = "threshold" | "commit";

const PATTERNS: Record<HapticPattern, number | number[]> = {
  /** The swipe crossed its action threshold. */
  threshold: 8,
  /** The action was revealed/committed. */
  commit: 14,
};

export function haptic(pattern: HapticPattern): boolean {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return false;
  try {
    return navigator.vibrate(PATTERNS[pattern]);
  } catch {
    return false;
  }
}
