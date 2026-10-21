import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, ClipboardList, Home, Plus, UserRound } from "lucide-react";
import { TabTapProvider, useTabTap } from "./TabTap";
import { LiveRegion } from "./LiveRegion";
import { READABLE_COLUMN_CLASS, WIDE_CANVAS_CLASS } from "./responsive";
import { useNavLayout } from "./navLayout";
import type { NavLayout } from "../appearance";
import { RouteTransition } from "./RouteTransition";
import { requestHistorySuppression } from "./backNavigation";
import { fetchUnreadCount } from "../services/notifications";
import { INBOX_CHANGED_EVENT } from "../services/notificationSignals";
import { onRealtime } from "../services/realtime";
import { PUSH_RECEIVED_EVENT } from "../services/pushNotifications";
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
  { to: "/profile", label: "Profile", icon: UserRound },
  { to: "/notifications", label: "Notifications", icon: Bell },
] as const;

const HIDE_NAV = ["/help", "/posts/", "/ai-connection"];

/**
 * Surfaces designed for a wide canvas (packet `09` §1/§2/§21).
 *
 * The shell used to clamp every screen to a 448px phone column. The feed
 * surfaces now use the canvas and grow more masonry columns; every other route
 * keeps the readable column so a tablet does not stretch paragraphs. A route
 * joins this set when it has actually been laid out for wide viewports — no
 * screen ever gets a wide layout nobody designed.
 */
const WIDE_CANVAS = ["/", "/search"];

/** The document never scrolls: routes own the bounded viewport scroller. */
export function Shell() {
  const { pathname } = useLocation();
  const showNav = !HIDE_NAV.some((p) => pathname.startsWith(p));
  const wideCanvas = WIDE_CANVAS.includes(pathname);
  const ownsInternalScroll =
    pathname === "/" || pathname === "/search" || pathname.startsWith("/help");
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
          <RouteTransition />
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
 * Both layouts share this destination list, the route targets, the active
 * treatment, the unread badge and the create action, so the two cannot drift.
 * `layout` picks only the wrapper and how labels are shown. `liveBadge` and
 * `activePath` exist for the visual fixture, which renders production nav
 * without auth or a live inbox; both default to the real shell behaviour.
 */
export function PrimaryNav({
  layout = "bottom",
  liveBadge = true,
  activePath,
  layoutScope = "shell",
}: {
  layout?: NavLayout;
  liveBadge?: boolean;
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
  // Badge only: count of unread notifications on the bell. Decorative
  // (aria-hidden) so the link's accessible name stays "Notifications".
  // Motion/refresh behavior is owned elsewhere; this never animates.
  const [unread, setUnread] = useState<number | null>(null);

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

  useEffect(() => {
    if (!liveBadge) return;
    let cancelled = false;
    const pull = () => {
      fetchUnreadCount().then(
        (count) => {
          if (!cancelled) setUnread(count);
        },
        () => {
          if (!cancelled) setUnread(null);
        },
      );
    };
    void pull();
    const onFocus = () => void pull();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void pull();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    // Private inbox signal: refetch the badge immediately on a new notification.
    const offInbox = onRealtime("notification:added", () => void pull());
    // A foregrounded push is a second signal (realtime can be disconnected).
    const onPush = () => void pull();
    window.addEventListener(PUSH_RECEIVED_EVENT, onPush);
    // Local read/unread/delete/restore on the inbox screen: keep the badge live.
    const onInboxChanged = () => void pull();
    window.addEventListener(INBOX_CHANGED_EVENT, onInboxChanged);
    return () => {
      cancelled = true;
      offInbox();
      window.removeEventListener(PUSH_RECEIVED_EVENT, onPush);
      window.removeEventListener(INBOX_CHANGED_EVENT, onInboxChanged);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [liveBadge]);

  const rail = layout === "rail";
  // The bottom bar sits where the keyboard appears, so it yields that space.
  // The rail is a column beside the content: the keyboard cannot cover it, and
  // hiding it would widen <main> by 6.5rem and pull it back, so it stays.
  if (fullscreen || (keyboardOpen && !rail)) return null;

  const selectedPath = activePath ?? (pathname === "/search" ? "/" : pathname);

  const createAction = (
    <Link to="/report" aria-label="Create report" className="fb-nav-create bg-primary text-on-primary">
      <Plus size={26} aria-hidden="true" />
    </Link>
  );

  const items = NAV.map(({ to, label, icon: Icon }) => {
    const selected = selectedPath === to;
    return (
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
        {to === "/notifications" && unread !== null && unread > 0 && (
          <span
            aria-hidden="true"
            data-testid="notifications-unread-badge"
            className="absolute right-1 top-1 z-[2] flex min-h-[20px] min-w-[20px] items-center justify-center rounded-full bg-error px-1 text-[11px] font-semibold text-on-error"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
        {rail ? (
          // A vertical list has room for every name; no label animation is
          // needed, and a name must never depend on selection to be readable.
          <span className="fb-nav-label">{label}</span>
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
