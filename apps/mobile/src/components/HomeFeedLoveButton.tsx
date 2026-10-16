import { useState } from "react";
import { Heart } from "lucide-react";
import type { ReactionKind, ReactionSummary } from "@findback/shared";
import { announce } from "./LiveRegion";
import { useFeedLove } from "../hooks/useFeedLove";
import { likeMine, likeState, nextLikeReaction } from "../services/reactions";
import { toggleLikeReaction } from "../services/feedReactions";

/**
 * The feed card's Like control (packet `08` §2 — reactions are Like-only).
 *
 * One tap toggles: `LIKE` when the caller holds no positive reaction, null when
 * they do (packet §2: new writes are Like/null only). The count is the card's
 * positive-reaction total and the heart is filled for the caller's own Like.
 * There is no tray, no chevron picker and no custom art any more — a legacy
 * Helpful/Support/Wow reaction from the multi-kind era reads as "mine", so a
 * tap clears it through the same one-row-per-caller rule.
 *
 * Outside a `FeedLoveProvider` (detail-less embeds, tests) it falls back to
 * local state and the same service call, with the same failure contract.
 */
export function HomeFeedLoveButton({
  postId,
  likeCount,
}: {
  postId: string;
  likeCount: number;
}) {
  const love = useFeedLove(postId);
  const [localReaction, setLocalReaction] = useState<ReactionKind | null>(null);
  const [localSummary, setLocalSummary] = useState<ReactionSummary | null>(null);
  const [localPending, setLocalPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const myReaction: ReactionKind | null = love?.myReaction ?? localReaction;
  const summary = love?.summary ?? localSummary;
  const mine = summary ? likeState(summary).mine : likeMine(myReaction);
  const count = summary ? likeState(summary).count : (love?.likeCount ?? likeCount);
  const pending = love?.pending ?? localPending;
  const errorId = `home-feed-like-error-${postId}`;
  const buttonId = `home-feed-like-button-${postId}`;

  function fail() {
    setFailed(true);
    announce("Couldn't save your like. Please try again.");
  }

  async function onToggle() {
    setFailed(false);
    if (love) {
      const ok = await love.toggle();
      if (!ok) fail();
      return;
    }
    if (localPending) return;
    const prev = localReaction;
    setLocalReaction(nextLikeReaction(prev));
    setLocalPending(true);
    try {
      const res = await toggleLikeReaction(postId, prev);
      setLocalSummary(res.reactionCounts ?? null);
    } catch {
      setLocalReaction(prev);
      fail();
    } finally {
      setLocalPending(false);
    }
  }

  const label = `${mine ? "Liked" : "Like this report"}, ${count} ${count === 1 ? "like" : "likes"}`;

  return (
    <span className="relative flex min-w-0 flex-col gap-1">
      <button
        type="button"
        id={buttonId}
        data-testid="home-feed-love"
        aria-pressed={mine}
        aria-label={label}
        aria-describedby={failed ? errorId : undefined}
        data-pending={pending ? "true" : "false"}
        disabled={pending}
        aria-busy={pending}
        onClick={() => void onToggle()}
        className={`fb-report-action min-h-[44px] min-w-[44px] flex-1 gap-1 ${mine ? "bg-surface-container text-on-surface" : "text-on-surface-variant"}`}
      >
        <Heart size={18} aria-hidden fill={mine ? "currentColor" : "none"} />
        <span aria-hidden className="tabular-nums">{count}</span>
      </button>
      {failed && (
        <span
          id={errorId}
          role="alert"
          data-testid="home-feed-love-error"
          className="text-[11px] text-error"
        >
          Couldn't save — try again
        </span>
      )}
    </span>
  );
}
