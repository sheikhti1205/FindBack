import { NavLink, Outlet, useLocation } from "react-router";
import { Home, PlusCircle, Search, UserRound } from "lucide-react";
import { TabTapProvider, useTabTap } from "./TabTap";
import { LiveRegion } from "./LiveRegion";
import { requestHistorySuppression } from "./backNavigation";

const NAV: Array<{
  to: string;
  label: string;
  icon: typeof Home;
  end?: boolean;
  /** Extra paths where this tab stays visually selected (e.g. /my under Profile). */
  extraActive?: string[];
}> = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/search", label: "Search", icon: Search },
  { to: "/report", label: "Report", icon: PlusCircle },
  { to: "/profile", label: "Profile", icon: UserRound, extraActive: ["/my"] },
];

/** Bottom navigation appears on tab screens only (not on detail/help/offline-ai screens). */
const HIDE_NAV = ["/help", "/posts/", "/offline-ai"];

export function Shell() {
  const { pathname } = useLocation();
  const showNav = !HIDE_NAV.some((p) => pathname.startsWith(p));

  return (
    <TabTapProvider>
      <div className="mx-auto flex min-h-full max-w-md flex-col bg-surface text-on-surface pt-[env(safe-area-inset-top)]">
        <main className="flex-1 pb-20">
          <Outlet />
        </main>
        {showNav && <BottomNav />}
        <LiveRegion />
      </div>
    </TabTapProvider>
  );
}

function BottomNav() {
  const { notifyTabTap } = useTabTap();
  const { pathname } = useLocation();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md border-t border-outline-variant bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <div className="grid grid-cols-4">
        {NAV.map(({ to, label, icon: Icon, end, extraActive }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={() => {
              // Active-tab tap: signal the screen to refresh/scroll-top.
              // /my counts as Profile so the tab signal still works there.
              const isActive =
                end
                  ? pathname === to
                  : pathname.startsWith(to) || extraActive?.includes(pathname);
              if (isActive) {
                notifyTabTap();
                // Re-tapping Home treats it as the true root: the next back
                // press should arm exit instead of walking history.
                if (to === "/") requestHistorySuppression("/");
              }
            }}
            className={({ isActive }) => {
              const selected = isActive || extraActive?.includes(pathname);
              return `flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] ${
                selected
                  ? "font-semibold text-on-surface"
                  : "text-on-surface-variant"
              }`;
            }}
          >
            <Icon size={22} aria-hidden />
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}