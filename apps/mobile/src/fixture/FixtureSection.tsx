import { useEffect, type CSSProperties, type ReactNode } from "react";
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
  "large-text": "Large text — the app's Extra-large scale, held on the root while this frame is mounted",
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

let largeTextFrames = 0;
/** What the root font size was before the first large-text frame took it. */
let rootFontSizeBeforeFrames: string | null = null;

/**
 * Large text is a GLOBAL scale in this app: `appearance.ts` writes a root font
 * size and every size under review is in `rem`, so a frame cannot scale only
 * itself. Writing the root font size from here is not enough on its own either
 * — React runs child effects before the app's own, so the app's
 * `applyAppearance` lands last and wins (measured: the frame still drew 15px
 * card titles).
 *
 * So while a large-text frame is mounted it holds the root font size at the
 * app's Extra-large value: on mount, again on the next frame (after the app's
 * own effect), and again whenever the app re-applies appearance. It never
 * touches the reader's stored setting — a review surface must not rewrite the
 * preference it is reviewing — and on unmount the app is asked to re-apply its
 * own settings, which is what hands the root back.
 */
function useLargeTextScale(active: boolean): void {
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const root = document.documentElement;
    const hold = () => {
      if (root.style.fontSize !== `${LARGE_TEXT_PERCENT}%`) {
        root.style.fontSize = `${LARGE_TEXT_PERCENT}%`;
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
  }, [active]);
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
  children: ReactNode;
}) {
  const dark = variant === "dark" || variant === "amoled";
  useLargeTextScale(variant === "large-text");
  return (
    <div
      data-testid={`fixture-${section}-${variant}`}
      data-fixture-section={section}
      data-fixture-variant={variant}
      data-fixture-theme={dark ? variant : "light"}
      {...(width
        ? { "data-frame-width": String(width), "data-columns": String(masonryColumns(width)) }
        : {})}
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
