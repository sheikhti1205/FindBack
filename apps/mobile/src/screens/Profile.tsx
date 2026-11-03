import { Bookmark, FileStack, MessagesSquare, Settings as SettingsIcon, ShieldQuestion, Star, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../auth";
import { UserAvatar } from "../components/UserAvatar";
import { SettingsGroup, SettingsPage, SettingsRow, StatusPill } from "../components/settings";
import {
  fetchReputationTier,
  REPUTATION_TIER_LABELS,
  type ReputationTier,
} from "../services/trust";

/**
 * Own-profile reputation. The tier is a SERVER-owned label (NEW / NORMAL /
 * TRUSTED): this reads it and never derives, averages or caches a score. The
 * value is keyed by account so a previous account's label cannot survive a
 * switch, and an unreadable tier says so instead of guessing.
 */
function useOwnReputation(userId: string | undefined) {
  const [state, setState] = useState<
    { accountId: string; status: "loading" } | { accountId: string; status: "ready"; tier: ReputationTier } | { accountId: string; status: "unavailable" }
  >({ accountId: userId ?? "", status: "loading" });
  useEffect(() => {
    let cancelled = false;
    const accountId = userId ?? "";
    if (!accountId) return;
    setState({ accountId, status: "loading" });
    void fetchReputationTier(accountId)
      .then((tier) => {
        if (!cancelled) setState({ accountId, status: "ready", tier });
      })
      .catch(() => {
        if (!cancelled) setState({ accountId, status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  // Never show a previous account's label during the first render after a switch.
  return state.accountId === (userId ?? "") ? state : { accountId: userId ?? "", status: "loading" as const };
}

/**
 * Profile landing: identity hero plus Public profile / My reports / Settings /
 * Help. Uses the shared settings page/group/row language (large title, grouped
 * card) so it reads as part of Settings, not a boxed utility screen.
 * The identity hero uses the canonical UserAvatar; the account email and
 * verification status stay owner-only (never part of the public profile).
 *
 * Profile is the ONE canonical trust surface (packet 08 §C/§D): the reputation
 * label and the way into ratings live here, not scattered onto every card, and
 * rating detail is reached from here rather than from Settings.
 */
export function Profile() {
  const { user } = useAuth();
  const reputation = useOwnReputation(user?.id);
  if (!user) return null;

  return (
    <SettingsPage title="Profile" backTo="/settings" backLabel="Back to Settings">
      <section
        aria-label="Account"
        className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
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
          className="col-start-2 flex min-h-[44px] items-center justify-self-start rounded-m3-md bg-surface-container px-4 text-sm font-medium text-on-surface hover:bg-surface-container-high sm:col-start-auto"
        >
          Edit profile
        </Link>
      </section>

      <SettingsGroup title="Reputation" description="Worked out by Norfold from your returns and ratings. Not a score you raise directly.">
        {reputation.status === "loading" && <p role="status" className="fb-settings-row-description">Checking your reputation…</p>}
        {reputation.status === "unavailable" && <p role="status" className="fb-settings-row-description">Your reputation is unavailable right now.</p>}
        {reputation.status === "ready" && (
          <p className="fb-settings-row-description" data-testid="profile-reputation">
            <StatusPill tone={reputation.tier === "TRUSTED" ? "success" : reputation.tier === "NORMAL" ? "accent" : "neutral"}>
              {REPUTATION_TIER_LABELS[reputation.tier]}
            </StatusPill>
          </p>
        )}
        <SettingsRow
          title="Ratings and recovered items"
          description="What came back, and what each side said."
          icon={Star}
          iconTone="amber"
          route="/settings/returns"
        />
      </SettingsGroup>

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
           <SettingsRow title="Chats" description="Messages and requests" icon={MessagesSquare} route="/chats" />
          <SettingsRow title="Saved reports" icon={Bookmark} route="/saved" />
          <SettingsRow title="Settings" icon={SettingsIcon} route="/settings" />
          <SettingsRow title="Help & guide" icon={ShieldQuestion} iconTone="sky" route="/settings/help" />
        </SettingsGroup>
      </nav>
    </SettingsPage>
  );
}
