import { useState } from "react";
import { ChevronDown, Heart } from "lucide-react";
import type { CanonicalReactionKind } from "@findback/shared";
import { announce } from "./LiveRegion";
import { useFeedLove } from "../hooks/useFeedLove";
import { ReactionTray, reactionKindLabel } from "./ReactionTray";
import { useLongPress } from "../hooks/useLongPress";
import {
  nextLoveReaction,
  seedSummaryFromItem,
  toggleLoveReaction,
} from "../services/feedReactions";
import {
  nextReactionForTap,
  normalizeReactionKind,
  setPostReaction,
  type ReactionKind,
  type ReactionSummary,
} from "../services/reactions";

/**
 * Home-feed reaction control (W3.3, UXN-2 flat row preserved).
 *
 * Always a SIBLING of the detail link — never nested inside it (see
 * PostCardContent home-feed block). The visible control stays the Love
 * toggle (same `home-feed-love` testid, same flat `fb-report-action`
 * styling, same LIKE/null default-tap wire), and gains:
 *
 * - press-and-hold (~400 ms) opens the multi-kind ReactionTray;
 * - an explicit "Choose reaction" menu button (no long-press needed);
 * - kind-aware labels (`Helpful, 5 reactions`) once the caller reacted.
 *
 * Inside a FeedLoveProvider (Home) the button hydrates from the batch call,
 * patches the feed cache optimistically, and reads the live counts. Outside
 * a provider it degrades to self-contained local state over the same real
 * RPCs so the card never crashes.
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
  // A failed toggle reverts silently at the data layer — the visible +
  // announced message here is the only failure signal (PostDetail actionError
  // pattern: inline role="alert" + announce).
  const [failed, setFailed] = useState(false);
  // Tray opener decides where Escape returns focus (main vs choose button).
  const [trayOpener, setTrayOpener] = useState<"main" | "choose" | null>(null);
  const trayOpen = trayOpener !== null;

  const myReaction: ReactionKind | null = love?.myReaction ?? localReaction;
  const myKind = myReaction === null ? null : normalizeReactionKind(myReaction);
  const loved = myKind === "LOVE";
  const active = myKind !== null;
  const summary: ReactionSummary | null =
    love?.summary ?? localSummary ?? seedSummaryFromItem(likeCount, 0, myReaction);
  const total = love?.total ?? summary.total;
  // The visible number stays the feed like count until a kind-aware summary
  // is known; then it is the server-truth total.
  const count = love?.summary || localSummary ? total : (love?.likeCount ?? likeCount);
  const pending = love?.pending ?? localPending;
  const errorId = `home-feed-love-error-${postId}`;
  const mainId = `home-feed-love-button-${postId}`;
  const chooseId = `home-feed-choose-${postId}`;

  const press = useLongPress(() => setTrayOpener("main"), { disabled: pending || trayOpen });

  function failLove() {
    setFailed(true);
    announce("Couldn't save your love. Please try again.");
  }

  function closeTray() {
    setTrayOpener(null);
  }

  function focusMain() {
    document.getElementById(mainId)?.focus({ preventScroll: true });
  }

  async function onToggle() {
    // A tap while the tray is open dismisses it instead of toggling.
    if (trayOpen) {
      closeTray();
      return;
    }
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

  /**
   * Tray write path: the tapped canonical kind goes to the real multi-kind
   * RPC (never faked over LIKE); tapping the active kind clears it. The
   * default tap above keeps the legacy LIKE/null wire.
   */
  async function onSelectKind(kind: CanonicalReactionKind) {
    closeTray();
    focusMain();
    setFailed(false);
    if (love) {
      const ok = await love.react(kind);
      if (!ok) failLove();
      return;
    }
    if (localPending) return;
    const prev = localReaction;
    const next = nextReactionForTap(prev, kind);
    setLocalReaction(next);
    setLocalPending(true);
    try {
      const res = await setPostReaction(postId, next);
      setLocalSummary(res);
    } catch {
      setLocalReaction(prev);
      failLove();
    } finally {
      setLocalPending(false);
    }
  }

  const label =
    myKind === null || loved
      ? `${active ? "Loved — tap to unlove this report" : "Love this report"}, ${count} ${count === 1 ? "love" : "loves"}`
      : `${reactionKindLabel(myKind as CanonicalReactionKind)}, ${count} ${count === 1 ? "reaction" : "reactions"}`;

  return (
    <span className="relative flex min-w-0 flex-col gap-1">
      <span className="flex min-w-0 items-stretch gap-0.5">
        <button
          type="button"
          id={mainId}
          data-testid="home-feed-love"
          aria-pressed={active}
          aria-label={label}
          aria-describedby={failed ? errorId : undefined}
          data-pending={pending ? "true" : "false"}
          // Disabled while in flight: a rapid second tap must not reach the
          // hook's in-flight guard (which reports "not failed") and surface a
          // false "Couldn't save" message for a request that is still running.
          disabled={pending}
          aria-busy={pending}
          onPointerDown={press.onPointerDown}
          onPointerMove={press.onPointerMove}
          onPointerUp={press.onPointerUp}
          onPointerCancel={press.onPointerCancel}
          onClick={() => {
            // A hold that opened the tray still fires click on pointerup —
            // swallow exactly that tap so it never toggles.
            if (press.claimTap()) return;
            void onToggle();
          }}
          className={`fb-report-action min-h-[44px] min-w-[44px] flex-1 ${active ? "bg-surface-container text-on-surface" : "text-on-surface-variant"}`}
        >
          <Heart size={18} aria-hidden fill={active ? "currentColor" : "none"} />
          <span aria-hidden>{count}</span>
        </button>
        <button
          type="button"
          id={chooseId}
          data-testid="home-feed-choose-reaction"
          aria-haspopup="menu"
          aria-expanded={trayOpen}
          aria-label="Choose reaction"
          disabled={pending}
          onClick={() => (trayOpen ? closeTray() : setTrayOpener("choose"))}
          className="fb-report-action min-h-[44px] min-w-[44px] shrink-0 text-on-surface-variant"
        >
          <ChevronDown size={16} aria-hidden />
        </button>
      </span>
      {trayOpen && (
        <span className="absolute bottom-full left-0 z-20 mb-1 w-max max-w-[78vw]">
          <ReactionTray
            open
            myReaction={myReaction}
            counts={summary.counts}
            total={summary.total}
            pending={pending}
            onSelect={(kind) => void onSelectKind(kind)}
            onClose={closeTray}
            triggerId={trayOpener === "choose" ? chooseId : mainId}
          />
        </span>
      )}
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
