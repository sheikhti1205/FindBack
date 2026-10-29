import { useEffect, useState } from "react";
import { Link } from "react-router";
import { motion } from "framer-motion";
import type { PostItem } from "@findback/shared";
import { ImageOff, MapPin } from "lucide-react";
import { useAuth } from "../auth";
import { EmptyState, Spinner } from "./PostCard";
import { PhotoLightbox } from "./PhotoLightbox";
import { loadAiPreferences } from "../services/ai/aiPreferences";
import { applyMatchesEngineToRuntime, findPossibleMatches, type PossibleMatchesResult } from "../services/possibleMatches";
import { listItemVariants, motionDurations, motionEasings, motionStagger } from "./uiMotion";
import { MATCH_RESULT_LIMIT, type MatchCandidate, type PossibleMatch } from "../services/similarity";

export interface PossibleMatchesProps {
  post: PostItem;
  /**
   * Confirmation seam for the recovery lane.
   *
   * The card does NOT perform the confirmation itself: it owns no recovery
   * service, no RPC and no write. The wiring lane passes a handler that
   * performs the real write; the card then offers "Confirm match" on every
   * suggestion. Without a handler the surface says plainly that confirming
   * is not available here rather than offering a button that cannot work.
   */
  onConfirmMatch?: (match: PossibleMatch) => void;
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

export function PossibleMatches({ post, onConfirmMatch }: PossibleMatchesProps) {
  // Account for the persisted matches-engine choice. Best effort and never
  // throwing: outside an AuthProvider (some test mounts) this stays "local".
  let account = "local";
  try {
    account = useAuth().user?.id ?? "local";
  } catch {
    account = "local";
  }

  // Candidate eligibility is viewer-specific. Reset results AND the photo
  // viewer before paint; the old instance's pending requests cannot publish
  // into a new account, even after an A → B → A round trip.
  return <AccountMatches key={account} account={account} post={post} onConfirmMatch={onConfirmMatch} />;
}

function AccountMatches({ account, post, onConfirmMatch }: PossibleMatchesProps & { account: string }) {
  const [result, setResult] = useState<PossibleMatchesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  // Canonical PhotoLightbox for match thumbs (single photo each: straight
  // in). The thumb button is a SIBLING of the detail link, never inside it —
  // a button nested in a link is invalid DOM (see PostCard home-feed).
  const [lightboxId, setLightboxId] = useState<string | null>(null);

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
    // Keyed on content, not the whole post object. `account` is not what makes
    // the switch safe — the parent key remounts this instance before paint —
    // but restating it here means a future refactor that drops the key still
    // re-runs the fetch instead of publishing A's candidates into B's session.
  }, [contentKey, attempt, account]);

  if (loading) {
    return <Spinner label="Finding possible matches…" />;
  }

  if (!result) {
    return null;
  }

  if (!result.available) {
    // Only a failed candidate fetch reaches here: the semantic pass degrades to
    // the text/structured comparison instead of hiding the whole surface.
    return (
      <div className="flex flex-col items-center gap-3">
        <EmptyState
          title="Possible matches unavailable"
          subtitle="Could not load reports to compare. Check your connection and try again."
        />
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

  const visibleMatches = result.matches.slice(0, MATCH_RESULT_LIMIT);
  const lightboxMatch =
    (lightboxId !== null
      ? visibleMatches.find((m) => m.post.id === lightboxId && m.post.photoUrl)
      : undefined) ?? null;

  // State the actual count, without suggesting a calibrated quality threshold.
  const suggestionSummary =
    visibleMatches.length < MATCH_RESULT_LIMIT
      ? `${visibleMatches.length} possible match${visibleMatches.length === 1 ? "" : "es"} to review. Up to ${MATCH_RESULT_LIMIT} are shown.`
      : `Showing up to ${MATCH_RESULT_LIMIT} possible matches.`;

  return (
    <section className="min-w-0 rounded-m3-lg border border-outline-variant bg-surface-container-low p-4" aria-labelledby="possible-matches-heading">
      <h2 id="possible-matches-heading" className="mb-3 text-base font-semibold">
        Possible matches
      </h2>
      <p className="mb-3 text-xs text-on-surface-variant">
        Compared {result.candidatesConsidered} recent report{result.candidatesConsidered === 1 ? "" : "s"}. {suggestionSummary}
      </p>
      <ul className="fb-scroll-row flex gap-3" role="list">
        {visibleMatches.map((match, index) => (
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
            className="flex min-w-0 max-w-full flex-[0_0_clamp(9rem,42%,12rem)] flex-col"
          >
            <div className="flex h-full flex-col gap-2 rounded-m3-md border border-outline-variant bg-surface p-2 transition-colors hover:border-on-surface-variant active:bg-surface-container">
              {match.post.photoUrl ? (
                <button
                  type="button"
                  onClick={() => setLightboxId(match.post.id)}
                  aria-label={`Open photo for ${match.post.title} fullscreen`}
                  className="block w-full"
                >
                  <MatchPhoto post={match.post} />
                </button>
              ) : (
                <MatchPhoto post={match.post} />
              )}
              <Link
                to={`/posts/${match.post.id}`}
                className="flex min-w-0 flex-1 flex-col gap-2"
              >
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
                <div className="flex flex-col gap-0.5">
                  <p className="text-xs font-medium text-on-surface-variant">Why it might match</p>
                  <ul className="list-disc pl-3 text-xs leading-snug text-on-surface-variant">
                    {match.reasons.map((reason) => (
                      <li key={reason} className="break-words">{reason}</li>
                    ))}
                  </ul>
                </div>
              )}
              </Link>
              {onConfirmMatch && (
                <button
                  type="button"
                  onClick={() => onConfirmMatch(match)}
                   aria-label={`Propose match: ${match.post.title}`}
                  className="min-h-[40px] w-full rounded-m3-sm border border-outline-variant px-2 text-xs font-medium text-on-surface transition-colors hover:border-on-surface-variant active:bg-surface-container"
                >
                   Propose match
                </button>
              )}
            </div>
          </motion.li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-on-surface-variant" role="note">
        {result.mode === "text"
          ? "These suggestions compare wording, category, date and place only — the on-device model isn’t available. They are not confirmed matches."
          : "These are text-similarity suggestions, not confirmed matches."}
      </p>
      {!onConfirmMatch && (
        <p className="mt-1 text-xs text-on-surface-variant">
          Confirming a match isn’t available here. Open a report to check the photos and details.
        </p>
      )}
      {lightboxMatch?.post.photoUrl && (
        <PhotoLightbox
          photo={{ id: lightboxMatch.post.id, previewUrl: lightboxMatch.post.photoUrl }}
          title={lightboxMatch.post.title}
          onClose={() => setLightboxId(null)}
        />
      )}
    </section>
  );
}
