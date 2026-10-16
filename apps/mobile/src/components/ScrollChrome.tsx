import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { motionDurations, motionEasings, useShouldReduceMotion } from "./uiMotion";

/**
 * The collapsing chrome shell (packet 09 §3).
 *
 * The decision of *when* to hide lives in `scrollChrome.ts` (pure, hysteresis,
 * pinned-aware). This component owns *how* it happens, and that is the whole
 * point of it being a component: the geometry, the reduced-motion override and
 * the inert contract are one thing, in one place, used by the Home screen and
 * reviewable on its own in the fixture route.
 *
 * - It collapses `height`, so the feed below gains real vertical room rather
 *   than sitting under a permanently tall header.
 * - `marginBottom` cancels the parent's `gap-4` while collapsed, so no stray
 *   band of empty space is left where the chrome used to be. It is animated
 *   with the height, not written straight through `style`: a `style` margin
 *   lands on the first frame while the height is still interpolating, which
 *   snapped the sibling up by the gap (measured 16px) before the motion
 *   started. This makes the wrapper depend on the parent using `gap-4`
 *   (1rem) — the alternative is a visible 16px hole, and the two are pinned
 *   together by the test below.
 * - `overflow: hidden` only while collapsed: a focus ring or dropdown is never
 *   clipped when the chrome is open.
 * - `inert` while collapsed: a keyboard or switch user cannot land on a control
 *   that is not on screen. It is a real attribute, not `aria-hidden` — the
 *   controls stay in the tree and keep their state.
 * - Reduced motion collapses instantly (the app's central decision, §19).
 *
 * Sheets and dialogs must NOT live inside this wrapper: `BottomSheet` mounts in
 * the component tree rather than a portal, so an open sheet inside a
 * height-collapsing element would be clipped.
 */
/**
 * The parent's `gap-4`, cancelled while collapsed (1rem = 16px). A component
 * cannot read its parent's gap, so this is the coupling: the wrapper is only
 * correct inside a `gap-4` (1rem) column — which is what the Home feed is.
 */
export const CHROME_GAP_CANCEL = "-1rem";

export function ScrollChrome({
  hidden,
  children,
  testId = "home-chrome",
  className,
}: {
  /** From `nextScrollChrome` — never computed from scroll here. */
  hidden: boolean;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  const reduceMotion = useShouldReduceMotion();
  return (
    <motion.div
      data-testid={testId}
      data-collapsed={hidden ? "true" : "false"}
      inert={hidden ? true : undefined}
      initial={false}
      animate={{
        height: hidden ? 0 : "auto",
        opacity: hidden ? 0 : 1,
        marginBottom: hidden ? CHROME_GAP_CANCEL : "0rem",
      }}
      transition={
        reduceMotion ? { duration: 0 } : { duration: motionDurations.standard, ease: motionEasings.out }
      }
      style={{ overflow: hidden ? "hidden" : "visible" }}
      className={`flex shrink-0 flex-col gap-4 ${className ?? ""}`}
    >
      {children}
    </motion.div>
  );
}
