import { useEffect, useState } from "react";
import { Link } from "react-router";
import { motion } from "framer-motion";
import type { PostItem } from "@findback/shared";
import { ImageOff, MapPin } from "lucide-react";
import { useAuth } from "../auth";
import { EmptyState, Spinner } from "./PostCard";
import { loadAiPreferences } from "../services/ai/aiPreferences";
import { applyMatchesEngineToRuntime } from "../screens/AiModels";
import { findPossibleMatches, type PossibleMatchesResult } from "../services/possibleMatches";
import { listItemVariants, motionDurations, motionEasings, motionStagger } from "./uiMotion";
import type { MatchCandidate } from "../services/similarity";

interface PossibleMatchesProps {
  post: PostItem;
}

function MatchPhoto({ post }: { post: MatchCandidate }) {
  const [failed, setFailed] = useState(false);
  return post.photoUrl && !failed ? (
    <img src={post.photoUrl} alt={`Photo for ${post.title}`} loading="lazy" onError={() => setFailed(true)} className="aspect-[4/3] w-full rounded-m3-sm object-cover" />
  ) : (
    <div className="flex aspect-[4/3] flex-col items-center justify-center gap-1 rounded-m3-sm bg-surface-container text-xs text-on-surface-variant">
      <ImageOff size={18} aria-hidden />{failed ? "Photo unavailable" : "No photo"}
    </div>
  );
}

export function PossibleMatches({ post }: PossibleMatchesProps) {
  const [result, setResult] = useState<PossibleMatchesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  // Account for the persisted matches-engine choice. Best effort and never
  // throwing: outside an AuthProvider (some test mounts) this stays "local".
  let account = "local";
  try {
    account = useAuth().user?.id ?? "local";
  } catch {
    account = "local";
  }

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
        // Apply the persisted matches engine at query time (Settings owns
        // the choice; this surface only borrows it). Best effort, never throws.
        try {
          applyMatchesEngineToRuntime(loadAiPreferences(account).matchesEngine);
        } catch {
          // A failed engine switch must never block matching itself.
        }
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
    <section className="min-w-0 rounded-m3-lg border border-outline-variant bg-surface-container-low p-4" aria-labelledby="possible-matches-heading">
      <h2 id="possible-matches-heading" className="mb-3 text-base font-semibold">
        Possible matches
      </h2>
      <p className="mb-3 text-xs text-on-surface-variant">
        Compared {result.candidatesConsidered} recent report{result.candidatesConsidered === 1 ? "" : "s"}.
      </p>
      <ul className="fb-scroll-row flex gap-3" role="list">
        {result.matches.slice(0, 3).map((match, index) => (
          <motion.li
            key={match.post.id}
            variants={listItemVariants}
            initial="hidden"
            animate="visible"
            transition={{
              duration: motionDurations.standard,
              ease: motionEasings.out,
              delay: index * motionStagger,
            }}
            className="flex min-w-0 flex-[0_0_clamp(9rem,42%,12rem)] flex-col"
          >
            <Link
              to={`/posts/${match.post.id}`}
              className="flex h-full flex-col gap-2 rounded-m3-md border border-outline-variant bg-surface p-2 transition-colors hover:border-on-surface-variant active:bg-surface-container"
            >
              <MatchPhoto post={match.post} />
              <h3 className="line-clamp-2 break-words text-sm font-semibold text-on-surface">{match.post.title}</h3>
              <div className="flex flex-col gap-1 text-xs text-on-surface-variant">
                <span className="self-start rounded-full border border-outline px-2 py-0.5 font-medium">
                  {match.post.category}
                </span>
                {match.post.eventDate && (
                  <time dateTime={match.post.eventDate}>
                    {match.post.eventDate}
                  </time>
                )}
                {match.post.locationLabel && (
                  <span className="flex items-start gap-1"><MapPin size={14} aria-hidden className="shrink-0" /><span className="line-clamp-2 break-words">{match.post.locationLabel}</span></span>
                )}
              </div>
              {match.reasons.length > 0 && (
                <p className="text-xs text-on-surface-variant">
                  Why: {match.reasons.join(", ")}
                </p>
              )}
            </Link>
          </motion.li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-on-surface-variant" role="note">
        These are text-similarity suggestions, not confirmed matches.
      </p>
    </section>
  );
}
