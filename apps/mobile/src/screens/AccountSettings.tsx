import { useState } from "react";
import { LogOut } from "lucide-react";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  StatusPill,
} from "../components/settings";
import { friendlyError } from "../utils/friendlyErrors";
import "./AccountSettings.css";

function initialsFor(username: string): string {
  const initial = username.trim().charAt(0);
  return initial ? initial.toUpperCase() : "?";
}

/**
 * Account detail screen (integrator: mount at `/settings/account`).
 *
 * Identity facts render as information rows, never as editable inputs:
 * - username: read-only (fixed at signup by the provisioning trigger).
 * - email: read-only. No email-change flow ships in this build, so there is
 *   no editable field; the `/verify` send/verify-code flow only re-verifies
 *   the existing address, so a Verify action is offered only while the
 *   stored email is unverified.
 * - mobile: editable via the profile editor (`/profile/edit`), which owns
 *   the validated Bangladesh update path.
 * - no phone verification row: no SMS provider ships, so the unsupported
 *   action/status is omitted rather than warned about.
 * - no avatar upload affordance: initials fallback only.
 */
export function AccountSettings() {
  const { user, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  if (!user) return null;

  return (
    <SettingsPage
      title="Account"
      description="Your sign-in details."
      backTo="/settings"
    >
      <SettingsGroup title="Account information">
        <SettingsRow
          title="Profile photo"
          value={
            user.avatarUrl ? (
              <img className="fb-account-avatar" src={user.avatarUrl} alt="" />
            ) : (
              <span aria-hidden="true" className="fb-account-avatar fb-account-avatar-initials">
                {initialsFor(user.username)}
              </span>
            )
          }
        />
        <SettingsRow
          title="Username"
          description="Fixed when your account was created."
          value={`@${user.username}`}
        />
        <SettingsRow
          title="Email"
          value={user.email}
          badge={
            user.emailVerified ? (
              <StatusPill tone="success">Verified</StatusPill>
            ) : undefined
          }
        />
        {!user.emailVerified && (
          <SettingsRow
            title="Verify email"
            description="Confirm access to this address with a code."
            route="/verify"
          />
        )}
        <SettingsRow
          title="Mobile number"
          description="Bangladesh mobile number."
          value={user.phone}
          route="/profile/edit"
        />
      </SettingsGroup>

      <Button
        variant="outline"
        loading={loggingOut}
        onClick={() => {
          if (loggingOut) return;
          setLoggingOut(true);
          setSignOutError(null);
          void logout()
            .catch((err: unknown) => {
              setSignOutError(friendlyError(err).message);
            })
            .finally(() => setLoggingOut(false));
        }}
      >
        <LogOut size={16} aria-hidden />
        Log out
      </Button>
      {signOutError ? (
        <p role="alert" className="fb-account-error">
          {signOutError}
        </p>
      ) : null}
    </SettingsPage>
  );
}
