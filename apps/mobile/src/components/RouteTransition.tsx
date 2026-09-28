import { useEffect, useRef } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { useLocation, useNavigationType, useOutlet } from "react-router";
import {
  motionDurations,
  motionEasings,
  pageBackwardVariants,
  pageForwardVariants,
  pageVariants,
} from "./uiMotion";

const TAB_PATHS = ["/", "/my", "/profile", "/notifications"];
const DETAIL_PREFIX = "/posts/";

function isTab(path: string): boolean {
  return TAB_PATHS.includes(path);
}

function isDetail(path: string): boolean {
  return path.startsWith(DETAIL_PREFIX);
}

/**
 * Wave A route-direction policy (pure, unit-tested):
 * - drilling into a detail page (`/posts/:id`) slides forward,
 * - leaving a detail page slides back,
 * - major tab switches crossfade (opacity only),
 * - everything else crossfades.
 *
 * Navigation itself is immediate (react-router swaps the outlet); motion
 * only accompanies it. The shell never unmounts — only this outlet wrapper
 * is keyed. AnimatePresence `popLayout` pops the exiting wrapper out of
 * normal flow (absolute, measured) so exiting and entering routes genuinely
 * occupy the same route stage instead of stacking vertically as two block
 * elements; the entering wrapper keeps `h-full min-h-0` so screens with
 * `flex h-full flex-col` internal scrollers (Home/Search/Help) still
 * resolve against a definite-height parent. popLayout stays compatible
 * with the LayoutGroup shared `layoutId` elements (card → detail media).
 */
export function resolveRouteVariants(
  from: string,
  to: string,
  navType?: string,
): typeof pageVariants {
  if (isDetail(to)) return pageForwardVariants;
  if (isDetail(from)) return pageBackwardVariants;
  if (navType === "POP") return pageBackwardVariants;
  if (isTab(from) && isTab(to)) return pageVariants;
  return pageVariants;
}

export function RouteTransition() {
  const location = useLocation();
  const navType = useNavigationType();
  // Freeze the outlet element at render time: AnimatePresence keeps the
  // exiting motion.div mounted for its exit animation, and a bare
  // `<Outlet />` inside it would re-resolve against the NEW router location
  // (showing the new screen twice). Capturing the element here lets the
  // exiting wrapper keep showing the old screen while the entering wrapper
  // shows the new one.
  const outlet = useOutlet();
  const prevRef = useRef(location.pathname);
  const from = prevRef.current;
  const to = location.pathname;
  const variants = resolveRouteVariants(from, to, navType);
  useEffect(() => {
    prevRef.current = location.pathname;
  }, [location.pathname]);

  return (
    <LayoutGroup>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={location.pathname}
          variants={variants}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
          className="h-full min-h-0"
          data-testid="route-transition"
          data-route={location.pathname}
        >
          {outlet}
        </motion.div>
      </AnimatePresence>
    </LayoutGroup>
  );
}
