import { Link } from "react-router";
import type { PublicUser } from "@findback/shared";
import { StatusPill } from "./settings";

/** Two-letter initials from a display name; never touches other fields. */
export function initialsFor(username: string): string {
  const parts = username.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]!}${parts[parts.length - 1]![0]!}`.toUpperCase();
}

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
      {user.avatarUrl ? (
        <img
          src={user.avatarUrl}
          alt=""
          width={64}
          height={64}
          className="h-16 w-16 flex-none rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-16 w-16 flex-none items-center justify-center rounded-full bg-surface-container text-lg font-semibold"
        >
          {initialsFor(user.username)}
        </span>
      )}
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
