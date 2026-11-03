import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import type { PublicUser } from "@norfold/shared";
import { UserAvatar } from "../../components/UserAvatar";

/**
 * Settings root profile header: canonical avatar, display name, @username,
 * and one View-profile affordance. The whole header is a single link to the
 * canonical `/profile` route — no nested controls, no clipped labels
 * (copy truncates with ellipsis inside a min-width:0 column).
 */
export function SettingsProfileHeader({ user }: { user: PublicUser }) {
  const displayName = (user.displayName ?? "").trim() || user.username;
  return (
    <Link
      to="/profile"
      aria-label={`View profile, ${displayName}, @${user.username}`}
      className="fb-settings-profile"
    >
      <UserAvatar avatarUrl={user.avatarUrl} username={user.username} size={40} />
      <span className="fb-settings-profile-copy">
        <span className="fb-settings-profile-name">{displayName}</span>
        <span className="fb-settings-profile-username">@{user.username}</span>
      </span>
      <span className="fb-settings-profile-edit">
        View profile
        <ChevronRight size={18} aria-hidden="true" className="fb-settings-chevron" />
      </span>
    </Link>
  );
}
