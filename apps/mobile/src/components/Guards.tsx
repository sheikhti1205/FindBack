import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useAuth } from "../auth";
import { Splash } from "../screens/Splash";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, booting } = useAuth();
  if (booting) return <Splash />;
  if (!user) return <Navigate to="/signin" replace />;
  return <>{children}</>;
}

export function GuestOnly({ children }: { children: ReactNode }) {
  const { user, booting } = useAuth();
  if (booting) return <Splash />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}
