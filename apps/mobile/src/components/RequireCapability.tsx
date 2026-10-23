import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router";
import { fetchMyRole } from "../services/roles";
import { useAuth } from "../auth";

export interface RequireCapabilityProps {
  /**
   * The permission the route needs, as the server names it.
   *
   * The name is never shown to a reader — it is a routing decision, not copy.
   */
  capability: string;
  children: ReactNode;
}

/**
 * A route that only an account holding one permission may open.
 *
 * The server is the authority: `findback_my_role` is the same read every
 * privileged surface uses, and the permission is re-checked by the server on
 * every call behind the route. This guard is the courtesy redirect, so a
 * typed URL does not open a half-loaded staff screen — a failed role read
 * counts as "not allowed", and the reader goes back to Settings.
 *
 * The screen behind the guard still checks the permission itself and says so
 * in words, so the two can never disagree about who may be here.
 */
export function RequireCapability({ capability, children }: RequireCapabilityProps) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/settings" replace />;
  // A new account or required capability gets a fresh unresolved guard before
  // any privileged child can render; old role responses die with their scope.
  return <ScopedCapability key={`${user.id}:${capability}`} capability={capability}>{children}</ScopedCapability>;
}

function ScopedCapability({ capability, children }: RequireCapabilityProps) {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchMyRole()
      .then((role) => {
        if (!alive) return;
        setAllowed(role.isAdmin === true || role.capabilities.includes(capability));
      })
      .catch(() => {
        if (alive) setAllowed(false);
      });
    return () => {
      alive = false;
    };
  }, [capability]);

  // One round trip: no flash of the staff surface before the role is known.
  if (allowed === null) return null;
  if (!allowed) return <Navigate to="/settings" replace />;
  return <>{children}</>;
}
