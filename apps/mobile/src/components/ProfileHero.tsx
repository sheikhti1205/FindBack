import { Link } from "react-router";
import type { PublicUser } from "@findback/shared";
import { StatusPill } from "./settings";
import { UserAvatar } from "./UserAvatar";

/** Re-exported from the canonical avatar module (single home, no import cycle). */
export { initialsFor } from "./UserAvatar";

/**
 * Profile identity hero: 64px avatar-or-initials, @username, email status,
 * secondary email, Edit action. No phone content, no verification copy for
 * unsupported channels.
 */
export function ProfileHero({ user }: { user: PublicUser }) {
  return (
    <section
      aria-label="Account"
      className="flex min-w-0 items-center gap-4 rounded-m3-md border border-outline-variant bg-surface-container-low p-4"
    >
      <UserAvatar avatarUrl={user.avatarUrl} username={user.username} size={64} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="truncate text-lg font-semibold">@{user.username}</p>
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
  );
}
