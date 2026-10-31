import type { ReactNode } from "react";
import { Link } from "react-router";
import { AdaptivePopover } from "./AdaptivePopover";
import { UserAvatar } from "./UserAvatar";

/** Public presentation only. Relationship/actions are supplied by the feature's
 * account-fenced owner; this view never queries emails, phones or permissions. */
export function UserQuickCard({ username, displayName, avatarUrl, relationship, actions, trigger }: {
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  relationship?: string;
  actions?: ReactNode;
  trigger?: ReactNode;
}) {
  const name = displayName?.trim() || username;
  return <AdaptivePopover label={`About ${name}`} trigger={trigger ?? <>
    <UserAvatar username={name} avatarUrl={avatarUrl} size={28} /><span className="fb-identity-name">{name}</span>
  </>}>
    <div className="fb-identity-header">
      <UserAvatar username={name} avatarUrl={avatarUrl} size={40} />
      <div className="min-w-0"><p className="fb-identity-name font-semibold">{name}</p><p className="fb-identity-handle">@{username}</p></div>
    </div>
    {relationship && <p className="fb-identity-relationship">{relationship}</p>}
    <div className="fb-identity-actions">
      <Link to={`/u/${encodeURIComponent(username)}`} className="fb-surface-button">View profile</Link>
      {actions}
    </div>
  </AdaptivePopover>;
}
