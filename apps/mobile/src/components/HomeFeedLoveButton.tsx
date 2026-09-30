import { useState } from "react";
import { Heart } from "lucide-react";
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

  const myReaction = love?.myReaction ?? localReaction;
  const loved = myReaction === "LIKE";
  const count = love?.likeCount ?? likeCount;
  const pending = love?.pending ?? localPending;

  async function onToggle() {
    if (love) {
      await love.toggle();
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
    } finally {
      setLocalPending(false);
    }
  }

  return (
    <button
      type="button"
      data-testid="home-feed-love"
      aria-pressed={loved}
      aria-label={loved ? "Loved — tap to unlove this report" : "Love this report"}
      data-pending={pending ? "true" : "false"}
      onClick={() => void onToggle()}
      className={`inline-flex min-h-[32px] items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium transition-colors ${
        loved ? "text-on-surface" : "text-on-surface-variant"
      }`}
    >
      <Heart size={14} aria-hidden fill={loved ? "currentColor" : "none"} />
      <span aria-hidden>{count}</span>
    </button>
  );
}
