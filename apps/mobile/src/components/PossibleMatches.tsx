import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { PostItem } from "@findback/shared";
import { EmptyState, Spinner } from "./PostCard";
import { findPossibleMatches, type PossibleMatchesResult } from "../services/possibleMatches";

interface PossibleMatchesProps {
  post: PostItem;
}

export function PossibleMatches({ post }: PossibleMatchesProps) {
  const [result, setResult] = useState<PossibleMatchesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  // Rerun only when the match-relevant content changes, not on every
  // realtime social update that replaces the post object. Ranking depends on
  // category/date/location too, so they belong in the key.
  const contentKey = [
    post.id,
    post.type,
    post.title,
    post.description,
    post.category ?? "",
    post.eventDate ?? "",
    post.latitude ?? "",
    post.longitude ?? "",
    post.locationLabel ?? "",
  ].join("|");

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setResult(null);
    async function load() {
      try {
        const data = await findPossibleMatches(post);
        if (mounted) {
          setResult(data);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      mounted = false;
    };
    // Intentionally keyed on content, not the whole post object.
  }, [contentKey, attempt]);

  if (loading) {
    return <Spinner label="Finding possible matches…" />;
  }

  if (!result) {
    return null;
  }

  if (!result.available) {
    const subtitle =
      result.unavailableReason === "embed"
        ? "Matching needs the on-device model, which is not available in this build."
        : "Could not load reports to compare. Check your connection and try again.";
    return (
      <div className="flex flex-col items-center gap-3">
        <EmptyState title="Possible matches unavailable" subtitle={subtitle} />
        <button
          type="button"
          onClick={() => setAttempt((a) => a + 1)}
          className="min-h-[48px] rounded-m3-sm border border-outline-variant px-4 text-sm font-medium"
        >
          Try again
        </button>
      </div>
    );
  }

  if (result.matches.length === 0) {
    // EMPTY (nothing to compare) vs no-matches-after-compare need different
    // copy: the first is about coverage, the second about similarity.
    if (result.candidatesConsidered === 0) {
      return (
        <EmptyState
          title="No reports to compare"
          subtitle="There are no open reports of the opposite type yet. Check back later as new reports are added."
        />
      );
    }
    return (
      <EmptyState
        title="No possible matches"
        subtitle="No similar reports found. Check back later as new reports are added."
      />
    );
  }

  return (
    <section className="rounded-m3-md border border-outline-variant bg-surface-container-low p-4" aria-labelledby="possible-matches-heading">
      <h2 id="possible-matches-heading" className="mb-3 text-base font-semibold">
        Possible matches
      </h2>
      <p className="mb-3 text-xs text-on-surface-variant">
        Compared {result.candidatesConsidered} recent report{result.candidatesConsidered === 1 ? "" : "s"}.
      </p>
      <ul className="flex flex-col gap-2" role="list">
        {result.matches.slice(0, 3).map((match) => (
          <li key={match.post.id} className="flex flex-col gap-1">
            <Link
              to={`/posts/${match.post.id}`}
              className="flex flex-col gap-1 rounded-m3-sm border border-outline-variant bg-surface p-3 transition-colors hover:border-on-surface-variant active:bg-surface-container"
            >
              <h3 className="font-medium text-on-surface">{match.post.title}</h3>
              <div className="flex flex-wrap items-center gap-2 text-sm text-on-surface-variant">
                <span className="rounded-full border border-outline px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide">
                  {match.post.category}
                </span>
                {match.post.eventDate && (
                  <time dateTime={match.post.eventDate}>
                    {match.post.eventDate}
                  </time>
                )}
                {match.post.locationLabel && (
                  <span>{match.post.locationLabel}</span>
                )}
              </div>
              {match.reasons.length > 0 && (
                <p className="text-xs text-on-surface-variant">
                  Why: {match.reasons.join(", ")}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-on-surface-variant" role="contentinfo">
        These are text-similarity suggestions, not confirmed matches.
      </p>
    </section>
  );
}
