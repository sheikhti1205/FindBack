import { NavLink, Outlet, useLocation } from "react-router";
import { Home, PlusCircle, Search, UserRound } from "lucide-react";

const NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/search", label: "Search", icon: Search },
  { to: "/report", label: "Report", icon: PlusCircle },
  { to: "/profile", label: "Profile", icon: UserRound },
];

/** Bottom navigation appears on tab screens only (not on detail/help/offline-ai screens). */
const HIDE_NAV = ["/help", "/posts/", "/offline-ai"];

export function Shell() {
  const { pathname } = useLocation();
  const showNav = !HIDE_NAV.some((p) => pathname.startsWith(p));

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-surface text-on-surface">
      <main className="flex-1 pb-20">
        <Outlet />
      </main>
      {showNav && <BottomNav />}
    </div>
  );
}

function BottomNav() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md border-t border-outline-variant bg-surface/95 backdrop-blur"
    >
      <div className="grid grid-cols-4">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] ${
                isActive
                  ? "font-semibold text-on-surface"
                  : "text-on-surface-variant"
              }`
            }
          >
            <Icon size={22} aria-hidden />
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
