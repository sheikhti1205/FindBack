import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Bot, Home, PlusCircle, Search, UserRound } from "lucide-react";
import { TabTapProvider, useTabTap } from "./TabTap";
import { AssistantSheet } from "./AssistantSheet";
import { LiveRegion } from "./LiveRegion";
import { requestHistorySuppression } from "./backNavigation";
import type { AssistantExecutionRuntime } from "../services/assistant/assistantExecution";
import { resolveLocalTextRuntime } from "../services/assistant/localTextRuntime";
import type { GuidedSnapshot } from "../services/assistant/guidedAssistantController";
import { mapAssistantSearchFilters } from "../services/assistant/searchFilterMapping";
import {
  ASSISTANT_REPORT_ROUTE,
  assistantReportNavigationTarget as reportHandoffTarget,
  stageAssistantReportHandoff,
} from "../services/assistant/assistantReportNavigation";
import { loadResidentEntryId } from "../services/models/roleSelection";
import {
  isTextRuntimePresent,
  type GenerateTextRequest,
  type GenerateTextResult,
} from "../services/models/textRuntime";
import {
  getVlmBridge,
  isTextBridge,
  type NativeTextRuntimeStatus,
} from "../services/vlmPlugin";
import { shellTextSeamsFromBridgeStatus } from "../services/models/qwenLifecycle";

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

/**
 * Assistant entry button appears only on low-friction tab screens and My
 * reports. Task-heavy routes (/report, /offline-ai, /help, /posts/*) and
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

/**
 * Seams for the assistant runtime hookup. Every field is optional: omitted
 * fields resolve from the live sources (resident record, bridge probe), so
 * production passes no seams and tests inject exact signals.
 */
export interface ShellAssistantSeams {
  /** Resident catalogue entry id override. Defaults to the stored resident record. */
  residentEntryId?: string | null;
  /** Real text-bridge probe override. Defaults to probing the bound bridge. */
  textRuntimePresent?: boolean;
  /**
   * Whether the preferred text model data is on device in an installed
   * state. Defaults to the live native status read while the sheet is
   * open, fail closed to the grounded fallback when unreadable.
   */
  textInstalled?: boolean;
  /**
   * Observed TEXT_READY proof for the preferred text model. Defaults to
   * the live native status read; installed without TEXT_READY never
   * answers locally and is never labeled ready.
   */
  textReady?: boolean;
  /** Explicit-modelId text generation override. Defaults to the bound bridge when present. */
  generateText?: (request: GenerateTextRequest) => Promise<GenerateTextResult>;
}

/**
 * Builds the assistant runtime for the open sheet. The preferred text
 * entry answers only while it is the resident entry, its data is
 * installed, TEXT_READY is observed, and the real text bridge is present;
 * any missing precondition resolves to a generator-free runtime and the
 * sheet stays on the deterministic grounded fallback. The result never
 * claims a model is active — the sheet states the fallback truthfully.
 */
export function resolveShellAssistantRuntime(
  seams: ShellAssistantSeams = {},
): AssistantExecutionRuntime {
  const bridge = getVlmBridge();
  const textRuntimePresent = seams.textRuntimePresent ?? isTextRuntimePresent(bridge);
  const generateText =
    seams.generateText ??
    (textRuntimePresent && isTextBridge(bridge)
      ? (request: GenerateTextRequest) => bridge.generateText(request)
      : undefined);
  if (generateText === undefined) return {};
  return resolveLocalTextRuntime({
    activeEntryId: seams.residentEntryId ?? loadResidentEntryId(),
    textRuntimePresent,
    installed: seams.textInstalled ?? false,
    textReady: seams.textReady ?? false,
    generateText,
  });
}

/**
 * Reads the live native text-runtime status for the open sheet. Returns
 * null when the bridge has no text surface or the read fails — callers
 * fail closed to the grounded fallback. Never initializes the runtime.
 */
export async function readTextRuntimeStatus(): Promise<NativeTextRuntimeStatus | null> {
  const bridge = getVlmBridge();
  if (!isTextBridge(bridge)) return null;
  try {
    return await bridge.getTextRuntimeStatus();
  } catch {
    return null;
  }
}

export function Shell({ seams }: { seams?: ShellAssistantSeams } = {}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const showNav = !HIDE_NAV.some((p) => pathname.startsWith(p));
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [textStatus, setTextStatus] = useState<NativeTextRuntimeStatus | null>(null);
  // Live native install/readiness read while the sheet is open. Explicit
  // seams always win (tests); otherwise the status read decides; when it
  // is missing or fails the resolver fails closed to the fallback.
  useEffect(() => {
    if (!assistantOpen) {
      setTextStatus(null);
      return;
    }
    let cancelled = false;
    readTextRuntimeStatus().then((status) => {
      if (!cancelled) setTextStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, [assistantOpen]);
  // Resolved fresh on every render while open, so a model activated in the
  // library is picked up without remounting the layout route.
  const liveSeams = { ...shellTextSeamsFromBridgeStatus(textStatus), ...(seams ?? {}) };
  const assistantRuntime = assistantOpen
    ? resolveShellAssistantRuntime(liveSeams)
    : undefined;
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
          runtime={assistantRuntime}
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