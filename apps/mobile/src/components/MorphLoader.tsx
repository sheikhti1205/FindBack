import { useShouldReduceMotion } from "./uiMotion";

/**
 * The Morph loading identity (packet 09 §15, owner-preferred concept).
 *
 * One shell, one bar:
 *
 * - an outer capsule in `surface-container-high`,
 * - an inner bar in `on-surface-variant` that stretches, shifts and settles
 *   (`fb-morph-bar`, defined in index.css) — calm, never a spinner, never a
 *   travel-heavy animation.
 *
 * Every surface that used to show a spinner borrows this identity: the compact
 * pagination capsule (§10) and the pull-to-refresh indicator (§12). The pull
 * indicator paints its own capsule by hand — it tracks a finger through rAF, not
 * React — so the shell and bar class strings are exported here rather than
 * duplicated there; the two cannot drift.
 *
 * Colors are tokens only (no hardcoded prototype green, no AI-colored loader),
 * and the bar's width, not a blur or a gradient, carries the motion, so this is
 * cheap on a low-end device.
 *
 * Reduced motion (the app's central decision, §19 — not a raw media query):
 * no travel and no morph. The capsule stays, the bar holds a fixed width. The
 * CSS animation is additionally killed by both the OS media query and the
 * `html.fb-reduce-motion` class, so the very first paint is already calm.
 */

export type MorphLoaderSize = "sm" | "md";

/** Shell geometry per size. `sm` is the compact pagination capsule. */
const SHELL_SIZE: Record<MorphLoaderSize, string> = {
  sm: "h-6 w-16",
  md: "h-9 w-20",
};

const BAR_SIZE: Record<MorphLoaderSize, string> = {
  sm: "h-1",
  md: "h-1.5",
};

/**
 * The capsule shell, without geometry. Shared with PullToRefresh.
 *
 * Deliberately carries NO `position` utility. The pull indicator is the shell
 * itself, absolutely positioned (`absolute left-1/2`) inside its sticky slot,
 * and Tailwind emits `relative` after `absolute` — so a `relative` here would
 * win the cascade and shove the capsule off to the side. Nothing inside the
 * shell is absolutely positioned, so it has no need of one either.
 */
export const MORPH_SHELL_CLASS =
  "inline-flex shrink-0 items-center justify-center rounded-full bg-surface-container-high";
/** The inner bar, without geometry. Shared with PullToRefresh. */
export const MORPH_BAR_CLASS = "rounded-full bg-on-surface-variant";
/** The keyframed morph (index.css). Applied only when motion is allowed. */
export const MORPH_BAR_ANIMATION_CLASS = "fb-morph-bar";

export function morphShellClass(size: MorphLoaderSize = "sm"): string {
  return `${MORPH_SHELL_CLASS} ${SHELL_SIZE[size]}`;
}

export function morphBarClass(size: MorphLoaderSize = "sm", animated = true): string {
  return [MORPH_BAR_CLASS, BAR_SIZE[size], animated ? MORPH_BAR_ANIMATION_CLASS : ""]
    .filter(Boolean)
    .join(" ");
}

export interface MorphLoaderProps {
  /** Announced to assistive tech; never shown unless `showLabel`. */
  label?: string;
  size?: MorphLoaderSize;
  /** Show the label as visible text (a page-level wait, never the feed slot). */
  showLabel?: boolean;
  className?: string;
}

/**
 * The standalone Morph indicator: a capsule with a bar that morphs while the
 * work is running. `role="status"` carries the accessible label so a screen
 * reader hears one polite announcement, not a stream of visual changes.
 */
export function MorphLoader({
  label = "Loading…",
  size = "sm",
  showLabel = false,
  className,
}: MorphLoaderProps) {
  const reduceMotion = useShouldReduceMotion();
  return (
    <div
      role="status"
      data-testid="morph-loader"
      data-animated={reduceMotion ? "false" : "true"}
      className={`flex items-center justify-center gap-3 text-on-surface-variant ${className ?? ""}`}
    >
      <span aria-hidden data-testid="morph-shell" className={morphShellClass(size)}>
        <span
          data-testid="morph-bar"
          data-animated={reduceMotion ? "false" : "true"}
          className={morphBarClass(size, !reduceMotion)}
          style={reduceMotion ? { width: "45%" } : undefined}
        />
      </span>
      {showLabel ? (
        <span className="text-sm">{label}</span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
    </div>
  );
}
