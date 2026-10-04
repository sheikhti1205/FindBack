import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import type { PublicUser } from "@findback/shared";
import { initialsFor } from "./ProfileHero";

/**
 * Settings account card: avatar, username, email, Manage account affordance.
 * The whole card is one link to /settings/account; no nested controls.
 */
export function AccountSummaryCard({ user }: { user: PublicUser }) {
  return (
    <Link
      to="/settings/account"
      aria-label={`Manage account, ${user.username}, ${user.email}`}
      className="fb-account-card"
    >
      {user.avatarUrl ? (
        <img
          src={user.avatarUrl}
          alt=""
          width={48}
          height={48}
          className="fb-account-avatar"
        />
      ) : (
        <span aria-hidden="true" className="fb-account-avatar fb-account-initials">
          {initialsFor(user.username)}
        </span>
      )}
      <span className="fb-account-copy">
        <span className="fb-account-name">{user.username}</span>
        <span className="fb-account-email">{user.email}</span>
        <span className="fb-account-manage">Manage account</span>
      </span>
      <ChevronRight size={18} aria-hidden="true" className="fb-settings-chevron" />
    </Link>
  );
}
