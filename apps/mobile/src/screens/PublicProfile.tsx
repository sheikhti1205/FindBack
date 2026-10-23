import { useEffect, useState } from "react";
import { useParams } from "react-router";
import type { PostItem, PublicProfile as PublicProfileShape } from "@findback/shared";
import { fetchPublicProfile, appendReportPage, hasMoreReports } from "../services/profile";
import { fetchFeed } from "../services/posts";
import { UserAvatar } from "../components/UserAvatar";
import { BlockedByViewerShield } from "../components/BlockedByViewerShield";
import { SafetyActions } from "../components/SafetyActions";
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
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setMoreError(null);
    setProfile(null);
    setReports([]);
    setNextCursor(null);
    (async () => {
      try {
        const found = await fetchPublicProfile(username);
        if (!alive) return;
        setProfile(found);
        try {
          const page = await fetchFeed({ userId: found.id });
          if (alive) {
            setReports(page.items);
            setNextCursor(page.nextCursor ?? null);
          }
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

  async function loadMoreReports() {
    if (!profile || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchFeed({ userId: profile.id }, nextCursor);
      setReports((previous) => appendReportPage(previous, page));
      setNextCursor(page.nextCursor ?? null);
    } catch {
      // The loaded profile and reports stay: only the next page failed.
      setMoreError("Could not load more reports. Check your connection and try again.");
    } finally {
      setLoadingMore(false);
    }
  }

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
            className="flex min-w-0 flex-col gap-3 py-2"
          >
            <div className="flex w-full items-start justify-between gap-3">
              <UserAvatar avatarUrl={profile.avatarUrl} username={profile.username} size={48} />
              <SafetyActions reportPerson person={{ userId: profile.id, name: profile.displayName || profile.username }} />
            </div>
            <div className="flex w-full min-w-0 flex-col gap-0.5 text-start">
            {profile.displayName && <p className="break-words text-base font-semibold">{profile.displayName}</p>}
            <p className="break-all text-sm text-on-surface-variant">@{profile.username}</p>
            <p className="text-xs text-on-surface-variant">{formatJoined(profile.createdAt)}</p>
            {(profile.emailVerified || profile.phoneVerified) && (
              <p className="flex flex-wrap gap-2">
                {profile.emailVerified && <StatusPill tone="success">Email verified</StatusPill>}
                {profile.phoneVerified && <StatusPill tone="neutral">Phone verified</StatusPill>}
              </p>
            )}
            {profile.bio && <p className="break-words text-sm text-on-surface">{profile.bio}</p>}
            {profile.locationLabel && (
              <p className="break-words text-sm text-on-surface-variant">{profile.locationLabel}</p>
            )}
            </div>
          </section>

          <SettingsGroup title="Reports">
            {reports.length === 0 ? (
              <p className="p-4 text-sm text-on-surface-variant">No public reports yet.</p>
            ) : (
              reports.map((report) => (
                // O5 mount (CF-060 R10): outside the SettingsRow anchor, whose
                // own docs forbid an interactive control inside the row.
                <BlockedByViewerShield
                  key={report.id}
                  rowId={report.id}
                  blocked={report.blockedAuthor}
                  mode="row"
                >
                  <SettingsRow
                    title={report.title}
                    description={report.type === "LOST" ? "Lost" : "Found"}
                    route={`/posts/${report.id}`}
                  />
                </BlockedByViewerShield>
              ))
            )}
            {hasMoreReports({ items: reports, nextCursor }) && (
              <div className="flex flex-col gap-2 p-4">
                {moreError && (
                  <p role="alert" className="text-sm text-error">
                    {moreError}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void loadMoreReports()}
                  disabled={loadingMore}
                  aria-busy={loadingMore}
                  className="min-h-[44px] rounded-m3-sm border border-outline-variant px-3 py-2 text-sm font-medium text-on-surface"
                >
                  {loadingMore ? "Loading more reports…" : "Load more reports"}
                </button>
              </div>
            )}
          </SettingsGroup>
        </>
      )}
    </SettingsPage>
  );
}
