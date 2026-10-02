import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useAuth } from "../auth";
import { Splash } from "../screens/Splash";
import { getPendingReportRoute } from "../utils/pendingReportLink";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, booting, bootError } = useAuth();
  // An unreachable backend keeps the boot screen with Retry instead of
  // dropping an unverified signed-out user at /signin.
  if (booting || (bootError && !user)) return <Splash />;
  if (!user) return <Navigate to="/signin" replace />;
  return <>{children}</>;
}

export function GuestOnly({ children }: { children: ReactNode }) {
  const { user, booting, bootError } = useAuth();
  if (booting || (bootError && !user)) return <Splash />;
  if (user) return <Navigate to={getPendingReportRoute() ?? "/"} replace />;
  return <>{children}</>;
}
