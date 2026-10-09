/**
 * Compact visual-density tokens (W4.1).
 *
 * Visual sizes shrink; effective touch targets never do. Every interactive
 * visual below keeps an effective hit area of at least `minTouchTarget`
 * (padding / negative-margin technique — never a smaller hit area).
 * All values are CSS pixels.
 */
export const density = {
  /** Normal primary button visual height (target 42–44). */
  primaryButtonHeight: 44,
  /** Compact secondary button visual height (target 36–40). */
  compactButtonHeight: 38,
  /** Category glyph visual size (target 20–22). */
  iconSize: 20,
  /** Settings row visual height (target 52–56; stays above the 48 comfort target). */
  settingsRowHeight: 54,
  /** Small chip visual height (target 28–32; chips are display-only). */
  chipHeight: 30,
  /** Common card padding (target 10–12). */
  cardPadding: 12,
  /** Common section gap (target 12–16). */
  sectionGap: 16,
  /** Common corner radius (target 10–14). */
  radius: 12,
  /** Minimum effective touch target; visual size may be smaller only when the hit area is preserved. */
  minTouchTarget: 44,
  /** Comfortable touch target for primary rows. */
  minTouchTargetComfortable: 48,
} as const;

export type Density = typeof density;
