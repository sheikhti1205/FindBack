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
import { describeCloudConnections } from "../services/aiCredentials";
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
  const [checkingKeys, setCheckingKeys] = useState(false);
  const [confirmKeyRemoval, setConfirmKeyRemoval] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  if (!user) return null;
  const userId = user.id;

  function runLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setSignOutError(null);
    void logout()
      .catch((err: unknown) => {
        setSignOutError(friendlyError(err).message);
      })
      .finally(() => setLoggingOut(false));
  }

  function handleSignOut() {
    if (loggingOut || checkingKeys) return;
    // A confirmed notice logs out immediately; the first click only probes
    // credential presence (provider ids, never key material).
    if (confirmKeyRemoval) {
      runLogout();
      return;
    }
    setCheckingKeys(true);
    void describeCloudConnections(userId).then(
      (connections) => {
        const hasStored =
          connections.connected ||
          connections.providers.length > 0 ||
          (connections.summary !== "" && connections.summary !== "Not connected");
        if (hasStored) {
          setConfirmKeyRemoval(true);
        } else {
          runLogout();
        }
      },
      () => {
        // A probe failure must never strand the user signed in; the logout
        // path purges stored keys regardless.
        runLogout();
      },
    ).finally(() => setCheckingKeys(false));
  }

  function cancelSignOut() {
    setConfirmKeyRemoval(false);
    setSignOutError(null);
  }

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
        loading={loggingOut || checkingKeys}
        onClick={handleSignOut}
      >
        <LogOut size={16} aria-hidden />
        Log out
      </Button>
      {confirmKeyRemoval ? (
        <div>
          <p role="status" className="fb-account-notice">
            Signing out will remove your stored AI provider keys from this
            device. You will need to enter them again after signing back in.
          </p>
          <div className="fb-account-confirm-row">
            <Button
              variant="outline"
              loading={loggingOut}
              onClick={runLogout}
            >
              Remove keys and log out
            </Button>
            <Button variant="text" disabled={loggingOut} onClick={cancelSignOut}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {signOutError ? (
        <p role="alert" className="fb-account-error">
          {signOutError}
        </p>
      ) : null}
    </SettingsPage>
  );
}
