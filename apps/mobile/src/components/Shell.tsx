import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, ClipboardList, Home, Plus, UserRound } from "lucide-react";
import { TabTapProvider, useTabTap } from "./TabTap";
import { LiveRegion } from "./LiveRegion";
import { READABLE_COLUMN_CLASS, WIDE_CANVAS_CLASS } from "./responsive";
import { RouteTransition } from "./RouteTransition";
import { requestHistorySuppression } from "./backNavigation";
import { fetchUnreadCount } from "../services/notifications";
import { INBOX_CHANGED_EVENT } from "../services/notificationSignals";
import { onRealtime } from "../services/realtime";
import { PUSH_RECEIVED_EVENT } from "../services/pushNotifications";
import {
  fadeUpVariants,
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

  return (
    <TabTapProvider>
      <div
        className={`fb-app-viewport mx-auto flex w-full flex-col bg-surface text-on-surface ${
          wideCanvas ? WIDE_CANVAS_CLASS : READABLE_COLUMN_CLASS
        }`}
      >
        <main className={`relative min-h-0 flex-1 ${ownsInternalScroll ? "overflow-hidden" : "overflow-y-auto"}`}>
          <RouteTransition />
        </main>
        {/* Wave A: route-driven nav hide/show slides+fades (short, transform/
            opacity only) instead of an instant unmount. AnimatePresence keeps
            the exiting nav in flow until its exit finishes, so route content
            does not jump mid-animation; once exited the nav is unmounted and
            therefore non-focusable / absent from the accessibility tree. */}
        <AnimatePresence initial={false}>
          {showNav && <BottomNav key="fb-bottom-nav" />}
        </AnimatePresence>
        <LiveRegion />
      </div>
    </TabTapProvider>
  );
}

function BottomNav() {
  const { notifyTabTap } = useTabTap();
  const { pathname } = useLocation();
  const [viewportBlocked, setViewportBlocked] = useState(false);
  // Badge only: count of unread notifications on the bell. Decorative
  // (aria-hidden) so the link's accessible name stays "Notifications".
  // Motion/refresh behavior is owned elsewhere; this never animates.
  const [unread, setUnread] = useState<number | null>(null);

  useEffect(() => {
    const update = () => {
      // The visual viewport shrinks when the on-screen keyboard opens. Keep
      // the nav out of its way; do not infer keyboard state from scroll.
      const keyboardOpen = !!window.visualViewport &&
        window.innerHeight - window.visualViewport.height > 120;
      setViewportBlocked(keyboardOpen || !!document.fullscreenElement);
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
  }, []);

  if (viewportBlocked) return null;

  const selectedPath = pathname === "/search" ? "/" : pathname;
  return (
    <motion.nav
      aria-label="Primary"
      className="fb-nav-slot shrink-0"
      variants={fadeUpVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
      transition={{ duration: motionDurations.fast, ease: motionEasings.out }}
    >
      <div className="fb-nav-row">
        <div className="fb-nav-pill">
          {NAV.map(({ to, label, icon: Icon }) => {
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
                    layoutId="fb-nav-active"
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
              </MotionLink>
            );
          })}
        </div>
        <motion.div className="fb-nav-create-wrap" whileTap={pressFeedback.iconButton}>
          <Link to="/report" aria-label="Create report" className="fb-nav-create bg-primary text-on-primary">
            <Plus size={26} aria-hidden="true" />
          </Link>
        </motion.div>
      </div>
    </motion.nav>
  );
}
