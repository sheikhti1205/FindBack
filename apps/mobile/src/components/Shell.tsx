import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { ClipboardList, Home, MessageCircle, Plus, Settings } from "lucide-react";
import { Focusable, Tooltip, TooltipTrigger } from "react-aria-components";
import { TabTapProvider, useTabTap } from "./TabTap";
import { LiveRegion } from "./LiveRegion";
import { MEDIUM_MAX_PX, READABLE_COLUMN_CLASS, useViewportWidth, WIDE_CANVAS_CLASS } from "./responsive";
import { useNavLayout } from "./navLayout";
import type { NavLayout } from "../appearance";
import { RouteTransition } from "./RouteTransition";
import { requestHistorySuppression } from "./backNavigation";
import { TopUtilities } from "./TopUtilities";
import {
  fadeUpVariants,
  fadeVariants,
  motionDurations,
  motionEasings,
  motionSprings,
  pressFeedback,
} from "./uiMotion";
import "./Shell.nav.css";

/** Router link with framer press gestures (motion pass: always animated). */
const MotionLink = motion.create(Link);

const NAV = [
  { to: "/", label: "Home", icon: Home },
  { to: "/my", label: "My Reports", icon: ClipboardList },
  { to: "/chats", label: "Chats", icon: MessageCircle },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

const HIDE_NAV = ["/help", "/posts/", "/ai-connection", "/connections/", "/chats/"];

/**
 * Surfaces designed for a wide canvas (packet `09` §1/§2/§21).
 *
 * The shell used to clamp every screen to a 448px phone column. The feed
 * surfaces now use the canvas and grow more masonry columns; every other route
 * keeps the readable column so a tablet does not stretch paragraphs. A route
 * joins this set when it has actually been laid out for wide viewports — no
 * screen ever gets a wide layout nobody designed.
 */
const WIDE_CANVAS = ["/", "/search", "/chats", "/connections"];

/** The document never scrolls: routes own the bounded viewport scroller. */
export function Shell() {
  const { pathname } = useLocation();
  const width = useViewportWidth();
  const chatThread = pathname.startsWith("/chats/") || pathname.startsWith("/connections/");
  const showNav = chatThread ? width >= MEDIUM_MAX_PX : !HIDE_NAV.some((p) => pathname.startsWith(p));
  const wideCanvas = WIDE_CANVAS.includes(pathname) || chatThread;
  const ownsInternalScroll =
    pathname === "/" || pathname === "/search" || pathname.startsWith("/help") || pathname.startsWith("/connections") || pathname.startsWith("/chats");
  // Owner ruling 4(e): the stored preference only becomes a side rail at the
  // compact breakpoint and up. The rail is an in-flow sibling of the content,
  // so it takes layout space and never covers what the reader is reading.
  const navLayout = useNavLayout();
  const rail = navLayout === "rail";
  const column = wideCanvas ? WIDE_CANVAS_CLASS : READABLE_COLUMN_CLASS;

  // A breakpoint flip replaces the whole navigation. The element that had focus
  // unmounts, so focus would otherwise fall to <body> and the next Tab would
  // restart at the top of the page; remember the focused destination and hand
  // focus to the same destination in the new layout.
  const focusedNavHref = useRef<string | null>(null);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const link = (event.target as Element | null)?.closest?.(
        'nav[aria-label="Primary"] a[href]',
      );
      focusedNavHref.current = link ? link.getAttribute("href") : null;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  useEffect(() => {
    const href = focusedNavHref.current;
    // Only when the flip actually dropped focus (the old nav is gone).
    if (!href || document.activeElement !== document.body) return;
    const nav = document.querySelector('nav[aria-label="Primary"]');
    const target = Array.from(
      nav?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? [],
    ).find((link) => link.getAttribute("href") === href);
    target?.focus();
  }, [navLayout]);

  return (
    <TabTapProvider>
      <div
        className={`fb-app-viewport flex w-full bg-surface text-on-surface ${
          rail ? "flex-row" : `mx-auto flex-col ${column}`
        }`}
      >
        {/* Wave A: route-driven nav hide/show slides+fades (short, transform/
            opacity only) instead of an instant unmount. AnimatePresence keeps
            the exiting nav in flow until its exit finishes, so route content
            does not jump mid-animation; once exited the nav is unmounted and
            therefore non-focusable / absent from the accessibility tree.

            A layout flip is NOT an exit: the two layouts are children of
            opposite flex contexts (row before <main>, column after it), so an
            exiting nav would stay in flow inside the *new* direction — a
            104×320px column above the content, or <main> squeezed to ~300px.
            Keying each boundary on the resolved layout remounts it on the
            flip, which drops the old nav in the same commit that flips the
            container: one paint, one nav, no intermediate geometry. Route
            hide/show inside a layout still animates because that key is
            stable. */}
        <AnimatePresence key={`fb-rail-boundary-${navLayout}`} initial={false}>
          {showNav && rail && <PrimaryNav key="fb-rail-nav" layout="rail" />}
        </AnimatePresence>
        <main
          className={`relative min-h-0 flex-1 ${rail ? `min-w-0 ${column}` : ""} ${
            ownsInternalScroll ? "overflow-hidden" : "overflow-y-auto"
          }`}
        >
          <div className="flex h-full min-h-0 flex-col">
            {showNav && pathname !== "/" && <div className="fb-utility-bar"><TopUtilities /></div>}
            <div className="min-h-0 flex-1"><RouteTransition /></div>
          </div>
        </main>
        <AnimatePresence key={`fb-bottom-boundary-${navLayout}`} initial={false}>
          {showNav && !rail && <PrimaryNav key="fb-bottom-nav" layout="bottom" />}
        </AnimatePresence>
        <LiveRegion />
      </div>
    </TabTapProvider>
  );
}

/**
 * The one primary navigation, rendered as a bottom bar or a side rail.
 *
 * Both layouts share destinations, selection and create action. Notifications
 * belong to TopUtilities, never this list. `activePath` allows a deterministic
 * visual fixture; normal navigation is router-owned.
 */
export function PrimaryNav({
  layout = "bottom",
  activePath,
  layoutScope = "shell",
}: {
  layout?: NavLayout;
  activePath?: string;
  /**
   * Identity for the selected-pill `layoutId`. Framer treats one `layoutId` as
   * ONE shared element, so several `PrimaryNav` copies on one page (the visual
   * fixture renders five) steal the pill from each other and the fill goes
   * missing. The app has a single nav, so the default is one scope; the fixture
   * gives each demo its own.
   */
  layoutScope?: string;
}) {
  const { notifyTabTap } = useTabTap();
  const { pathname } = useLocation();
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const update = () => {
      // The visual viewport shrinks when the on-screen keyboard opens. Keep
      // the bottom bar out of its way; do not infer keyboard state from scroll.
      setKeyboardOpen(!!window.visualViewport &&
        window.innerHeight - window.visualViewport.height > 120);
      setFullscreen(!!document.fullscreenElement);
    };
    update();
    window.visualViewport?.addEventListener("resize", update);
    document.addEventListener("fullscreenchange", update);
    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      document.removeEventListener("fullscreenchange", update);
    };
  }, []);

  const rail = layout === "rail";
  // The bottom bar sits where the keyboard appears, so it yields that space.
  // The rail is a column beside the content: the keyboard cannot cover it, and
  // hiding it would widen <main> by 6.5rem and pull it back, so it stays.
  if (fullscreen || (keyboardOpen && !rail)) return null;

  const belongsTo = (root: string) => pathname === root || pathname.startsWith(`${root}/`);
  const selectedPath = activePath ?? (belongsTo("/chats") || belongsTo("/connections") ? "/chats"
    : belongsTo("/settings") || belongsTo("/profile") ? "/settings"
    : belongsTo("/my") ? "/my" : pathname === "/search" ? "/" : pathname);

  const createAction = (
    <Link to="/report" aria-label="Create report" className="fb-nav-create bg-primary text-on-primary">
      <Plus size={26} aria-hidden="true" />
    </Link>
  );

  const items = NAV.map(({ to, label, icon: Icon }) => {
    const selected = selectedPath === to;
    const link = (
      <MotionLink
        key={to}
        to={to}
        aria-label={selected ? undefined : label}
        aria-current={selected ? "page" : undefined}
        onClick={() => {
          if (selected) {
            notifyTabTap();
            if (to === "/") requestHistorySuppression("/");
          }
        }}
        whileTap={pressFeedback.iconButton}
        transition={{ duration: motionDurations.instant }}
        className={`fb-nav-link ${selected ? "fb-nav-link-active text-on-primary-container" : "text-on-surface-variant"}`}
      >
        {selected && (
          <motion.span
            // One layout id per layout AND per mounted nav: a rail and a bar
            // briefly coexist at the breakpoint, and repeated fixture demos
            // would otherwise share (and lose) the pill.
            layoutId={`fb-nav-active-${layout}-${layoutScope}`}
            className="fb-nav-active-bg bg-primary-container"
            transition={motionSprings.snappy}
            aria-hidden="true"
          />
        )}
        <Icon
          size={22}
          strokeWidth={selected ? 2.5 : 2}
          className="fb-nav-icon"
          aria-hidden="true"
        />
        {rail ? (
          // Compact icon rail: accessible name always present; React Aria
          // exposes the same name visually on hover AND keyboard focus.
          <span className="fb-nav-label sr-only">{label}</span>
        ) : (
          <AnimatePresence initial={false}>
            {selected && (
              <motion.span
                key="fb-nav-label"
                className="fb-nav-label"
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: "auto" }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: motionDurations.fast }}
                style={{ overflow: "hidden", whiteSpace: "nowrap" }}
              >{label}</motion.span>
            )}
          </AnimatePresence>
        )}
      </MotionLink>
    );
    return <TooltipTrigger key={to} delay={350}>
      <Focusable>{link}</Focusable><Tooltip placement={rail ? "right" : "top"} className="fb-nav-tooltip">{label}</Tooltip>
    </TooltipTrigger>;
  });

  if (rail) {
    return (
      <motion.nav
        aria-label="Primary"
        data-layout="rail"
        className="fb-nav-rail shrink-0"
        variants={fadeVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
        transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
      >
        <motion.div className="fb-nav-create-wrap" whileTap={pressFeedback.iconButton}>
          {createAction}
        </motion.div>
        <div className="fb-nav-rail-list">{items}</div>
      </motion.nav>
    );
  }

  return (
    <motion.nav
      aria-label="Primary"
      data-layout="bottom"
      className="fb-nav-slot shrink-0"
      variants={fadeUpVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
    >
      <div className="fb-nav-row">
        <div className="fb-nav-pill">{items}</div>
        <motion.div className="fb-nav-create-wrap" whileTap={pressFeedback.iconButton}>
          {createAction}
        </motion.div>
      </div>
    </motion.nav>
  );
}
