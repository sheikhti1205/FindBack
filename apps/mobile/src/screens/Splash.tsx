import { motion } from "framer-motion";
import { Navigate } from "react-router";
import { useAuth } from "../auth";
import { BrandMark } from "../components/BrandMark";
import { motionDurations, motionEasings } from "../components/uiMotion";
import { getBootDiagnostics } from "../services/bootDiagnostics";
import { getPendingReportRoute } from "../utils/pendingReportLink";
import { hasPendingReportLink, isOnboardingComplete } from "../services/onboarding";

/**
 * Boot screen: shows briefly while a stored session hydrates, then redirects.
 * When the backend is unreachable, the stored session is kept and Retry is
 * offered — boot never assumes signed-out and never destroys the session.
 */
export function Splash() {
  const { user, booting, bootError, retryBoot } = useAuth();

  if (booting) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-surface text-on-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: motionDurations.emphasized, ease: motionEasings.out }}
          aria-hidden
        >
          <BrandMark size={64} />
        </motion.div>
        <p className="text-sm text-on-surface-variant">FindBack</p>
      </div>
    );
  }

  if (bootError && !user) {
    const stages = getBootDiagnostics();
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-surface px-6 text-center text-on-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <p className="text-lg font-semibold">Couldn't connect to FindBack.</p>
        <p className="max-w-xs text-sm text-on-surface-variant">
          Your saved sign-in is kept. Check your connection and try again.
        </p>
        <button
          type="button"
          onClick={retryBoot}
          className="min-h-[48px] rounded-m3-md bg-on-surface px-6 text-sm font-medium text-surface"
        >
          Retry
        </button>
        {import.meta.env.DEV && stages.length > 0 && (
          <details className="mt-2 max-w-xs text-left text-xs text-on-surface-variant">
            <summary className="cursor-pointer">Boot diagnostics</summary>
            <ul className="mt-1 break-words">
              {stages.map((s, i) => (
                <li key={i}>
                  {s.stage}
                  {s.detail ? ` (${s.detail})` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  }

  // Signed-in users resume (a pending shared-report link wins); fresh guests
  // with incomplete onboarding start there, unless a pending link bypasses
  // them to auth — the link itself is resumed by ReportLinkHandler/auth flow.
  if (user) return <Navigate to={getPendingReportRoute() ?? "/"} replace />;
  const guestHome =
    !isOnboardingComplete() && !hasPendingReportLink() ? "/onboarding" : "/auth";
  return <Navigate to={guestHome} replace />;
}
