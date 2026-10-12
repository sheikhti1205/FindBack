import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { useAuth } from "../auth";
import { requestAccountDeletion } from "../services/auth";
import { fetchPhoneChangeEligibility, formatPhoneChangeEligibleAt } from "../services/profile";
import { Button } from "../components/Button";
import { UserAvatar } from "../components/UserAvatar";
import {
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  StatusPill,
} from "../components/settings";
import { describeCloudConnections } from "../services/aiCredentials";
import { friendlyError } from "../utils/friendlyErrors";
import "./AccountSettings.css";

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
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  // Six-month replacement gate (spec 25, W5-IDENTITY): server-read only.
  // A fetch failure leaves this null and the row keeps its default copy —
  // availability is never guessed locally and no countdown is fabricated.
  const [phoneEligibility, setPhoneEligibility] = useState<{
    eligible: boolean;
    eligibleAt: string | null;
  } | null>(null);

  // Server-read replacement availability for the mobile row. Runs once per
  // account; failures are supplementary (default copy stays). Declared before
  // the early returns below so hook order stays stable.
  const accountId = user?.id ?? null;
  useEffect(() => {
    let alive = true;
    setPhoneEligibility(null);
    if (!accountId) return () => {
      alive = false;
    };
    void fetchPhoneChangeEligibility()
      .then((gate) => {
        if (alive) setPhoneEligibility({ eligible: gate.eligible, eligibleAt: gate.eligibleAt });
      })
      .catch(() => {
        if (alive) setPhoneEligibility(null);
      });
    return () => {
      alive = false;
    };
  }, [accountId]);

  // After a confirmed deletion the logout wipe signs the user out; the
  // success panel stays mounted so the outcome is never a silent landing.
  if (deleted) {
    return (
      <SettingsPage title="Account" description="Your sign-in details." backTo="/settings">
        <p role="status" className="fb-account-notice">
          Your account was permanently deleted, including its reports, photos,
          and data on our servers. This device has been signed out and its
          stored keys removed.
        </p>
      </SettingsPage>
    );
  }

  if (!user) return null;
  const userId = user.id;

  // Held gate without a date still names the block (never the default copy):
  // matches the dateless request_phone_change 409 ("You cannot change your
  // mobile number yet. Try again later.") in row-length form.
  const mobileGateHeld = phoneEligibility !== null && !phoneEligibility.eligible;
  const mobileCooldown = mobileGateHeld
    ? formatPhoneChangeEligibleAt(phoneEligibility.eligibleAt)
    : "";
  const mobileDescription = mobileCooldown
    ? `Number change available ${mobileCooldown}.`
    : mobileGateHeld
      ? "Number change is not available yet. Try again later."
      : "Bangladesh mobile number.";

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

  /** Server-confirmed deletion, then the normal logout wipe. */
  function runDeleteAccount() {
    if (deleting || !user) return;
    setDeleting(true);
    setDeleteError(null);
    void requestAccountDeletion()
      .then(async () => {
        setDeleted(true);
        setDeleteArmed(false);
        await logout();
      })
      .catch((err: unknown) => {
        setDeleteError(friendlyError(err).message);
      })
      .finally(() => setDeleting(false));
  }

  function cancelDeleteAccount() {
    setDeleteArmed(false);
    setDeleteEmail("");
    setDeleteError(null);
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
          value={<UserAvatar avatarUrl={user.avatarUrl} username={user.username} size={40} />}
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
          description={mobileDescription}
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

      <SettingsGroup title="Delete account">
        <p className="fb-account-notice">
          Permanently deletes your account, its reports and photos, and its
          data on our servers. This cannot be undone.
        </p>
        {!deleteArmed ? (
          <Button variant="error" onClick={() => { setDeleteArmed(true); setDeleteError(null); }}>
            Delete account…
          </Button>
        ) : (
          <div>
            <label htmlFor="fb-delete-confirm-email">
              Type your email address ({user.email}) to confirm deletion.
            </label>
            <input
              id="fb-delete-confirm-email"
              type="email"
              autoComplete="off"
              value={deleteEmail}
              disabled={deleting}
              onChange={(event) => setDeleteEmail(event.target.value)}
            />
            <div className="fb-account-confirm-row">
              <Button
                variant="error"
                loading={deleting}
                disabled={deleteEmail.trim().toLowerCase() !== user.email.toLowerCase()}
                onClick={runDeleteAccount}
              >
                Permanently delete my account
              </Button>
              <Button variant="text" disabled={deleting} onClick={cancelDeleteAccount}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </SettingsGroup>
      {deleteError ? (
        <p role="alert" className="fb-account-error">
          {deleteError}
        </p>
      ) : null}
    </SettingsPage>
  );
}
