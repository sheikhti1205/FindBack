import { useEffect, useRef } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { Outlet, useLocation, useNavigationType } from "react-router";
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
 * is keyed, so exit/enter overlap briefly (sync AnimatePresence) which also
 * lets shared `layoutId` elements (card → detail media) travel.
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
  const prevRef = useRef(location.pathname);
  const from = prevRef.current;
  const to = location.pathname;
  const variants = resolveRouteVariants(from, to, navType);
  useEffect(() => {
    prevRef.current = location.pathname;
  }, [location.pathname]);

  return (
    <LayoutGroup>
      <AnimatePresence initial={false}>
        <motion.div
          key={location.pathname}
          variants={variants}
          initial="hidden"
          animate="visible"
          exit="exit"
          transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
          data-testid="route-transition"
          data-route={location.pathname}
        >
          <Outlet />
        </motion.div>
      </AnimatePresence>
    </LayoutGroup>
  );
}
