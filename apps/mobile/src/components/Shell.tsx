import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Bot, Home, PlusCircle, Search, UserRound } from "lucide-react";
import { TabTapProvider, useTabTap } from "./TabTap";
import { AssistantSheet } from "./AssistantSheet";
import { LiveRegion } from "./LiveRegion";
import { requestHistorySuppression } from "./backNavigation";
import type { GuidedSnapshot } from "../services/assistant/guidedAssistantController";
import { mapAssistantSearchFilters } from "../services/assistant/searchFilterMapping";
import {
  ASSISTANT_REPORT_ROUTE,
  assistantReportNavigationTarget as reportHandoffTarget,
  stageAssistantReportHandoff,
} from "../services/assistant/assistantReportNavigation";

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

/** Bottom navigation appears on tab screens only. */
const HIDE_NAV = ["/help", "/posts/", "/ai-connection"];

/**
 * Assistant entry button appears only on low-friction tab screens and My
 * reports. Task-heavy routes (/report, /ai-connection, /help, /posts/*) and
 * unknown routes hide it by safe default so it never obstructs the task.
 */
const ASSISTANT_FAB_ROUTES: ReadonlySet<string> = new Set(["/", "/search", "/profile", "/my"]);

export function shouldShowAssistantFab(pathname: string): boolean {
  return ASSISTANT_FAB_ROUTES.has(pathname);
}

/**
 * Search route for a search-ready assistant snapshot, else null. Only a
 * completed search flow (state `ready` with extracted filters) navigates;
 * collecting/recovering/report snapshots never leave the sheet.
 */
export function assistantSearchNavigationTarget(snapshot: GuidedSnapshot): string | null {
  if (
    snapshot.flow !== "search" ||
    snapshot.state !== "ready" ||
    snapshot.searchFilters === undefined
  ) {
    return null;
  }
  return mapAssistantSearchFilters(snapshot.searchFilters).path;
}

/**
 * Versioned Review-report navigation seam. Returns the ordinary report route
 * only for the frozen assistant handoff; otherwise null. CreateReport owns
 * intake and never auto-publishes.
 */
export function assistantReportNavigationTarget(handoff: unknown): string | null {
  return reportHandoffTarget(handoff);
}

export { ASSISTANT_REPORT_ROUTE };

export function Shell() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const showNav = !HIDE_NAV.some((p) => pathname.startsWith(p));
  const [assistantOpen, setAssistantOpen] = useState(false);
  const showFab = shouldShowAssistantFab(pathname) && !assistantOpen;

  return (
    <TabTapProvider>
      <div className="mx-auto flex min-h-full max-w-md flex-col bg-surface text-on-surface pt-[env(safe-area-inset-top)]">
        <main className="flex-1 pb-20">
          <Outlet />
        </main>
        {showNav && <BottomNav />}
        {showFab && (
        <button
          type="button"
          data-testid="assistant-entry"
          aria-label="Open assistant"
          onClick={() => setAssistantOpen(true)}
          className="fixed right-4 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-on-surface text-surface shadow-lg bottom-[calc(6rem+env(safe-area-inset-bottom))]"
        >
          <Bot size={24} aria-hidden />
        </button>
        )}
        <AssistantSheet
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          onSnapshot={(snapshot) => {
            const target = assistantSearchNavigationTarget(snapshot);
            if (target !== null) {
              setAssistantOpen(false);
              navigate(target);
            }
          }}
          onReviewReport={(handoff) => {
            const target = assistantReportNavigationTarget(handoff);
            if (target === null) return;
            stageAssistantReportHandoff(handoff);
            setAssistantOpen(false);
            navigate(target);
          }}
        />
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
