import { FileStack, Settings as SettingsIcon, ShieldQuestion, UserRound } from "lucide-react";
import { Link } from "react-router";
import { useAuth } from "../auth";
import { UserAvatar } from "../components/UserAvatar";
import { SettingsGroup, SettingsPage, SettingsRow, StatusPill } from "../components/settings";

/**
 * Profile landing: identity hero plus Public profile / My reports / Settings /
 * Help. Uses the shared settings page/group/row language (large title, grouped
 * card) so it reads as part of Settings, not a boxed utility screen.
 * The identity hero uses the canonical UserAvatar; the account email and
 * verification status stay owner-only (never part of the public profile).
 */
export function Profile() {
  const { user } = useAuth();
  if (!user) return null;

  return (
    <SettingsPage title="Profile">
      <section
        aria-label="Account"
        className="flex min-w-0 items-center gap-3 py-2"
      >
        <UserAvatar avatarUrl={user.avatarUrl} username={user.username} size={48} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {user.displayName && <p className="truncate text-lg font-semibold">{user.displayName}</p>}
          <p className="truncate text-sm text-on-surface-variant">@{user.username}</p>
          {user.emailVerified ? (
            <p>
              <StatusPill tone="success">Email verified</StatusPill>
            </p>
          ) : (
            <Link to="/verify" className="text-sm font-medium text-on-surface underline">
              Verify email
            </Link>
          )}
          <p className="truncate text-sm text-on-surface-variant">{user.email}</p>
        </div>
        <Link
          to="/profile/edit"
          className="flex min-h-[44px] flex-none items-center rounded-m3-md border border-outline-variant px-4 text-sm font-medium hover:bg-surface-container"
        >
          Edit profile
        </Link>
      </section>

      <nav aria-label="Profile actions">
        <SettingsGroup>
          <SettingsRow
            title="Public profile"
            description="See how others view your profile"
            icon={UserRound}
            iconTone="blue"
            route={`/u/${user.username}`}
          />
          <SettingsRow title="My reports" icon={FileStack} route="/my" />
          <SettingsRow title="Settings" icon={SettingsIcon} route="/settings" />
          <SettingsRow title="Help & guide" icon={ShieldQuestion} iconTone="sky" route="/settings/help" />
        </SettingsGroup>
      </nav>
    </SettingsPage>
  );
}
