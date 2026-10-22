import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../auth";
import { fetchMyRole } from "../services/roles";
import { Splash } from "../screens/Splash";
import { Onboarding } from "../screens/Onboarding";
import { getPendingReportRoute } from "../utils/pendingReportLink";
import {
  hasPendingReportLink,
  isOnboardingComplete,
  resolvePendingLinkBypassDestination,
} from "../services/onboarding";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, booting, bootError } = useAuth();
  // An unreachable backend keeps the boot screen with Retry instead of
  // dropping an unverified signed-out user at /auth.
  if (booting || (bootError && !user)) return <Splash />;
  if (!user) return <Navigate to="/auth" replace />;
  return <>{children}</>;
}

/**
 * Staff-only routes. The Settings row is already hidden from a non-admin, but
 * a typed URL must never reach the console. The database is the authority; this
 * is the courtesy redirect, so a failed role read counts as "not an admin" and
 * the reader returns to Settings instead of seeing a half-loaded console.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchMyRole()
      .then((role) => {
        if (alive) setIsAdmin(role.isAdmin === true);
      })
      .catch(() => {
        if (alive) setIsAdmin(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // One round-trip: no flash of the console before the role is known.
  if (isAdmin === null) return null;
  if (!isAdmin) return <Navigate to="/settings" replace />;
  return <>{children}</>;
}

export function GuestOnly({ children }: { children: ReactNode }) {
  const { user, booting, bootError, needsProfile } = useAuth();
  if (booting || (bootError && !user)) return <Splash />;
  if (user) return <Navigate to={getPendingReportRoute() ?? "/"} replace />;
  // W0-C (W0-QA defect 1): restart-while-incomplete. A kept session with no
  // FindBack profile must resume at completion, ahead of the pending-link and
  // onboarding branches below (completion itself resumes the pending link).
  if (!user && needsProfile) return <Navigate to="/complete-profile" replace />;
  // A pending shared-report launch bypasses first-run flow: stay on the auth
  // path so the link resumes after sign-in (never consumed here).
  if (hasPendingReportLink()) return <>{children}</>;
  // Fresh guests with incomplete onboarding start there, not at auth.
  if (!isOnboardingComplete()) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

/**
 * First-run onboarding route (`/onboarding`, guest) + replay
 * (`/onboarding?replay=1`, signed-in). Returning signed-in users bypass;
 * a pending shared-report launch bypasses to `/auth` without consuming the
 * link (ReportLinkHandler stays authoritative for the resume). Replay always
 * renders, keeps completion sticky, and returns to `/settings`.
 */
export function OnboardingRoute() {
  const { user, booting, bootError } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  if (booting || (bootError && !user)) return <Splash />;
  const replay = params.get("replay") === "1";
  if (replay) {
    return (
      <Onboarding
        onComplete={() => navigate(user ? "/settings" : "/auth", { replace: true })}
      />
    );
  }
  if (user) return <Navigate to={getPendingReportRoute() ?? "/"} replace />;
  if (hasPendingReportLink()) {
    return <Navigate to={resolvePendingLinkBypassDestination(false)} replace />;
  }
  if (isOnboardingComplete()) return <Navigate to="/auth" replace />;
  return <Onboarding onComplete={() => navigate("/auth", { replace: true })} />;
}
