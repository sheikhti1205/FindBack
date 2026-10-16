import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { APPEARANCE_EVENT, TEXT_SCALE_OPTIONS, applyAppearance, loadAppearance } from "../appearance";
import { masonryColumns } from "../components/responsive";

/**
 * L-FIXTURE section chrome. Plain route + sections only — no new heavy
 * deps. Each section renders one production surface across a fixed variant
 * list (normal, loading, empty, error, long-content, large-text, dark,
 * AMOLED, small-width 320dp). The frame attributes (`data-fixture-section`,
 * `data-fixture-variant`, `data-frame-width`) are the hooks reviewers and tests
 * use.
 *
 * Two variants used to lie, and both lies made reviewed screenshots worthless:
 *
 * - `dark`/`amoled` painted inline colours on the frame div while the app's
 *   themes are class-scoped token sets. Every component that reads a `--fb-*`
 *   token therefore still rendered LIGHT (measured: a masonry title at rgb(33,
 *   37, 41) on rgb(0, 0, 0) — 1.36:1). The real theme class is applied instead,
 *   so the tokens switch for the whole subtree, because custom properties
 *   inherit.
 * - `large-text` set `font-size: 125%` on the frame div. Almost every size under
 *   review is in rem, which resolves against the ROOT font size, so nothing
 *   scaled. The frame now holds the root font size at the app's own Extra-large
 *   value while it is mounted, and hands the root back on unmount — the label
 *   says the effect is page-wide, because a root font size cannot be scoped to a
 *   box.
 */

export type FixtureVariant =
  | "normal"
  | "loading"
  | "empty"
  | "error"
  | "long-content"
  | "large-text"
  | "dark"
  | "amoled"
  | "small-width";

export const ALL_VARIANTS: FixtureVariant[] = [
  "normal",
  "loading",
  "empty",
  "error",
  "long-content",
  "large-text",
  "dark",
  "amoled",
  "small-width",
];

export const VARIANT_LABELS: Record<FixtureVariant, string> = {
  normal: "Normal",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  "long-content": "Long content",
  "large-text": "Large text — page-wide: the app's Extra-large root scale, held while the top switch is on",
  dark: "Dark",
  amoled: "AMOLED",
  "small-width": "Small width (320dp)",
};

/**
 * The largest text scale the app offers, read from the app so the two cannot
 * drift.
 */
export const LARGE_TEXT_PERCENT =
  TEXT_SCALE_OPTIONS.find((option) => option.id === "xlarge")?.percent ?? 125;

/**
 * The scale the page-wide switch compares against. Held explicitly rather than
 * "handing the root back to whatever the reviewer has saved": a reviewer whose
 * own setting is already Extra large would otherwise see the switch do nothing,
 * which is exactly how a comparison control turns into a decorative one.
 */
export const STANDARD_TEXT_PERCENT =
  TEXT_SCALE_OPTIONS.find((option) => option.id === "standard")?.percent ?? 100;

let largeTextFrames = 0;
/** What the root font size was before the first large-text frame took it. */
let rootFontSizeBeforeFrames: string | null = null;

/**
 * F4: whether the review surface holds the app's Extra-large scale. This is
 * PAGE-GLOBAL on purpose — a root font size cannot be scoped to one frame, so a
 * per-frame switch would be a lie: nine large-text frames hold the root, and
 * releasing one of them changes nothing a reviewer can see. One switch, at the
 * top of the route, and every large-text frame reports the state it is in.
 */
let fixtureLargeTextHeld = true;
const largeTextHoldListeners = new Set<() => void>();

/** Used by the page-level switch in `FixtureRoute`. */
export function setFixtureLargeTextHeld(held: boolean): void {
  if (fixtureLargeTextHeld === held) return;
  fixtureLargeTextHeld = held;
  for (const notify of largeTextHoldListeners) notify();
}

/** Whether the Extra-large scale is currently held page-wide. */
export function useFixtureLargeTextHeld(): boolean {
  const [, forceRender] = useState(0);
  useEffect(() => {
    const notify = () => forceRender((n) => n + 1);
    largeTextHoldListeners.add(notify);
    return () => {
      largeTextHoldListeners.delete(notify);
    };
  }, []);
  return fixtureLargeTextHeld;
}

/**
 * The one control for the page-wide hold. A root `font-size` is global, so this
 * belongs to the page, not to a frame.
 */
export function FixtureLargeTextToggle() {
  const held = useFixtureLargeTextHeld();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid="fixture-large-text-toggle"
        aria-pressed={held}
        onClick={() => setFixtureLargeTextHeld(!held)}
        className="inline-flex min-h-[44px] items-center rounded-m3-sm border border-outline-variant px-3 text-sm font-medium"
      >
        {held ? "Extra large text: on (whole page)" : "Extra large text: off"}
      </button>
      <span className="text-xs text-on-surface-variant">
        The text scale is a root setting, so it applies to the whole page, not to
        one frame — flip it to compare the large-text frames against the standard
        scale.
      </span>
    </div>
  );
}

/**
 * Large text is a GLOBAL scale in this app: `appearance.ts` writes a root font
 * size and every size under review is in `rem`, so a frame cannot scale only
 * itself. Writing the root font size from here is not enough on its own either
 * — React runs child effects before the app's own, so the app's
 * `applyAppearance` lands last and wins (measured: the frame still drew 15px
 * card titles).
 *
 * So while a large-text frame is mounted it holds the root font size at one of
 * the app's own two scales — Extra large, or Standard when the page switch is
 * off: on mount, again on the next frame (after the app's own effect), and again
 * whenever the app re-applies appearance. Holding Standard rather than "handing
 * the root back" is what makes the switch a real comparison for a reviewer whose
 * own saved scale is already Extra large (and it keeps the review surface
 * deterministic). It never
 * touches the reader's stored setting — a review surface must not rewrite the
 * preference it is reviewing — and on unmount the app is asked to re-apply its
 * own settings, which is what hands the root back.
 */
function useLargeTextScale(percent: number | null): void {
  useEffect(() => {
    if (percent === null || typeof window === "undefined") return;
    const root = document.documentElement;
    const hold = () => {
      if (root.style.fontSize !== `${percent}%`) {
        root.style.fontSize = `${percent}%`;
      }
    };
    if (rootFontSizeBeforeFrames === null) rootFontSizeBeforeFrames = root.style.fontSize;
    largeTextFrames += 1;
    hold();
    const raf = window.requestAnimationFrame(hold);
    window.addEventListener(APPEARANCE_EVENT, hold);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener(APPEARANCE_EVENT, hold);
      largeTextFrames -= 1;
      if (largeTextFrames === 0) {
        const previous = rootFontSizeBeforeFrames;
        rootFontSizeBeforeFrames = null;
        // Hand the root back: re-applying the reader's own settings is the
        // app's mechanism, so the fixture cannot leave a stale scale behind.
        applyAppearance(loadAppearance());
        if (previous !== null && previous !== root.style.fontSize) {
          root.style.fontSize = previous;
        }
      }
    };
  }, [percent]);
}

function frameStyle(variant: FixtureVariant, width?: number): CSSProperties {
  switch (variant) {
    case "small-width":
      return { maxWidth: 320, marginInline: "auto", width: "100%" };
    default:
      // A band frame carries the width the band claims; the grid inside it is
      // then the geometry production would actually produce at that width.
      return width ? { width, flex: "none" } : {};
  }
}

export function FixtureFrame({
  section,
  variant,
  width,
  geometry = false,
  measurements,
  children,
}: {
  section: string;
  variant: FixtureVariant;
  /** Renders the frame at exactly this width, so band maths can be reviewed. */
  width?: number;
  /**
   * A geometry frame: no border and no padding, so the content box IS the width
   * the band claims and the grid inside it is the one production produces at
   * that width (the app's own `px-4` list gutter is the only inset left, which
   * is exactly what `masonryColumns` budgets for).
   */
  geometry?: boolean;
  /**
   * The card widths this frame's caption publishes, declared as data instead of
   * being re-parsed back out of the prose. `fixture.test.tsx` pins the
   * declaration against its goldens, the rendered caption against the
   * declaration (both directions), and the frame's geometry against the
   * declaration's premise — so a caption number can neither drift from the
   * declaration nor appear undeclared. A frame that prints a measurement
   * without declaring it fails.
   */
  measurements?: readonly (string | number)[];
  children: ReactNode;
}) {
  const dark = variant === "dark" || variant === "amoled";
  // F4: the text scale is a ROOT setting, so the hold is page-wide — it scales
  // the other frames on the page too, which is exactly what a reader on Extra
  // large sees. The switch makes that consequence reviewable instead of
  // pretending the frame is self-contained: on = the Extra-large render (the
  // worst case, and what the band/dark frames are usually measured against),
  // off = the standard scale, held explicitly so the comparison works whatever
  // scale the reviewer has saved.
  const largeText = variant === "large-text";
  const largeTextHeld = useFixtureLargeTextHeld();
  useLargeTextScale(largeText ? (largeTextHeld ? LARGE_TEXT_PERCENT : STANDARD_TEXT_PERCENT) : null);
  return (
    <div
      data-testid={`fixture-${section}-${variant}`}
      data-fixture-section={section}
      data-fixture-variant={variant}
      data-fixture-theme={dark ? variant : "light"}
      {...(largeText
        ? { "data-fixture-large-text": largeTextHeld ? "extralarge" : "standard" }
        : {})}
      {...(width
        ? { "data-frame-width": String(width), "data-columns": String(masonryColumns(width)) }
        : {})}
      {...(measurements ? { "data-frame-measurements": measurements.join(" ") } : {})}
      style={frameStyle(variant, width)}
      // Every frame is a mini-viewport: it paints the app's own surface token
      // and text token, so a `dark`/`amoled` frame is dark all the way down
      // instead of showing the light page background through its gaps. No
      // inline colour anywhere: the tokens are switched by the class.
      className={`overflow-hidden bg-surface text-on-surface${
        geometry ? "" : " rounded-m3-md border border-outline-variant"
      }${dark ? ` ${variant}` : ""}`}
    >
      <p className="border-b border-outline-variant px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-on-surface-variant">
        {VARIANT_LABELS[variant]}
        {largeText ? (
          <span className="ml-2 font-normal normal-case tracking-normal">
            {largeTextHeld
              ? `(${LARGE_TEXT_PERCENT}% held — page-wide; switch at the top)`
              : `(${STANDARD_TEXT_PERCENT}% held — switch at the top)`}
          </span>
        ) : null}
      </p>
      <div className={geometry ? "" : "p-3"}>{children}</div>
    </div>
  );
}

export function FixtureSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      id={`fixture-${id}`}
      aria-label={title}
      data-testid={`fixture-section-${id}`}
      data-fixture-section-root={id}
      className="flex flex-col gap-3 scroll-mt-4"
    >
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-on-surface-variant">{description}</p>
      </div>
      {children}
    </section>
  );
}
