import { useState } from "react";
import { Heart } from "lucide-react";
import { announce } from "./LiveRegion";
import { useFeedLove } from "../hooks/useFeedLove";
import {
  nextLoveReaction,
  toggleLoveReaction,
  type CallerReaction,
} from "../services/feedReactions";

/**
 * Home-feed Love toggle (UXN-2). Always a SIBLING of the detail link — never
 * nested inside it (see PostCardContent home-feed block).
 *
 * Inside a FeedLoveProvider (Home) the button hydrates from the batch call,
 * patches the feed cache optimistically, and shows the live feed count.
 * Outside a provider it degrades to self-contained local state over the same
 * LIKE/null RPC so the card never crashes.
 */
export function HomeFeedLoveButton({
  postId,
  likeCount,
}: {
  postId: string;
  likeCount: number;
}) {
  const love = useFeedLove(postId);
  const [localReaction, setLocalReaction] = useState<CallerReaction>(null);
  const [localPending, setLocalPending] = useState(false);
  // A failed toggle reverts silently at the data layer — the visible +
  // announced message here is the only failure signal (PostDetail actionError
  // pattern: inline role="alert" + announce).
  const [failed, setFailed] = useState(false);

  const myReaction = love?.myReaction ?? localReaction;
  const loved = myReaction === "LIKE";
  const count = love?.likeCount ?? likeCount;
  const pending = love?.pending ?? localPending;
  const errorId = `home-feed-love-error-${postId}`;

  function failLove() {
    setFailed(true);
    announce("Couldn't save your love. Please try again.");
  }

  async function onToggle() {
    setFailed(false);
    if (love) {
      const ok = await love.toggle();
      if (!ok) failLove();
      return;
    }
    if (localPending) return;
    const prev = localReaction;
    setLocalReaction(nextLoveReaction(prev));
    setLocalPending(true);
    try {
      await toggleLoveReaction(postId, prev);
    } catch {
      setLocalReaction(prev);
      failLove();
    } finally {
      setLocalPending(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        data-testid="home-feed-love"
        aria-pressed={loved}
        aria-label={loved ? "Loved — tap to unlove this report" : "Love this report"}
        aria-describedby={failed ? errorId : undefined}
        data-pending={pending ? "true" : "false"}
        onClick={() => void onToggle()}
        className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
          loved ? "text-on-surface" : "text-on-surface-variant"
        }`}
      >
        <Heart size={14} aria-hidden fill={loved ? "currentColor" : "none"} />
        <span aria-hidden>{count}</span>
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
