import { useEffect, useState } from "react";
import { useParams } from "react-router";
import type { PostItem, PublicProfile as PublicProfileShape } from "@findback/shared";
import { fetchPublicProfile } from "../services/profile";
import { fetchFeed } from "../services/posts";
import { UserAvatar } from "../components/UserAvatar";
import { SettingsGroup, SettingsPage, SettingsRow, StatusPill } from "../components/settings";

/** "Joined January 2026" from an ISO timestamp; tolerant of bad input. */
function formatJoined(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "Joined recently";
  return `Joined ${date.toLocaleDateString(undefined, { year: "numeric", month: "long" })}`;
}

/**
 * Read-only public profile for another member, reached from a report author or
 * a profile link (`/u/:username`). Shows only the public identity surface —
 * avatar, display name, @username, bio, verification badges, join date — and
 * that member's reports via the existing feed API. Email and phone never travel
 * here: `fetchPublicProfile` maps the safe RPC columns only.
 */
export function PublicProfile() {
  const { username = "" } = useParams();
  const [profile, setProfile] = useState<PublicProfileShape | null>(null);
  const [reports, setReports] = useState<PostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setProfile(null);
    setReports([]);
    (async () => {
      try {
        const found = await fetchPublicProfile(username);
        if (!alive) return;
        setProfile(found);
        try {
          const page = await fetchFeed({ userId: found.id });
          if (alive) setReports(page.items);
        } catch {
          // Reports are supplementary: a feed failure never hides the profile.
        }
      } catch {
        if (alive) setError("That profile could not be found.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [username]);

  return (
    <SettingsPage title="Profile" backTo="/" backLabel="Back">
      {loading && <p role="status">Loading profile…</p>}
      {error && (
        <p
          role="alert"
          className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error"
        >
          {error}
        </p>
      )}
      {profile && (
        <>
          <section
            aria-label="Public profile"
            className="flex min-w-0 items-center gap-3 py-2"
          >
            <UserAvatar avatarUrl={profile.avatarUrl} username={profile.username} size={48} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-start">
            {profile.displayName && <p className="truncate text-base font-semibold">{profile.displayName}</p>}
            <p className="truncate text-sm text-on-surface-variant">@{profile.username}</p>
            <p className="text-xs text-on-surface-variant">{formatJoined(profile.createdAt)}</p>
            {(profile.emailVerified || profile.phoneVerified) && (
              <p className="flex flex-wrap gap-2">
                {profile.emailVerified && <StatusPill tone="success">Email verified</StatusPill>}
                {profile.phoneVerified && <StatusPill tone="neutral">Phone verified</StatusPill>}
              </p>
            )}
            {profile.bio && <p className="text-sm text-on-surface">{profile.bio}</p>}
            {profile.locationLabel && (
              <p className="text-sm text-on-surface-variant">{profile.locationLabel}</p>
            )}
            </div>
          </section>

          <SettingsGroup title="Reports">
            {reports.length === 0 ? (
              <p className="p-4 text-sm text-on-surface-variant">No public reports yet.</p>
            ) : (
              reports.map((report) => (
                <SettingsRow
                  key={report.id}
                  title={report.title}
                  description={report.type === "LOST" ? "Lost" : "Found"}
                  route={`/posts/${report.id}`}
                />
              ))
            )}
          </SettingsGroup>
        </>
      )}
    </SettingsPage>
  );
}
