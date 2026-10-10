import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { CanonicalReactionKind } from "@findback/shared";
import { announce } from "./LiveRegion";
import { useFeedLove } from "../hooks/useFeedLove";
import { ReactionTray, reactionKindLabel } from "./ReactionTray";
import { ReactionArt } from "./ReactionArt";
import { ReactionPreviewStack } from "./ReactionPreviewStack";
import { useLongPress } from "../hooks/useLongPress";
import { useSlideSelect } from "../hooks/useSlideSelect";
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
 * C2 home-feed reaction control: floating pill + slide-to-select + preview.
 *
 * - Tap toggles the default Love (LIKE/null wire); hold (~400 ms) opens the
 *   floating pill; the finger may slide across choices while held (hovered
 *   lifts) and release selects; vertical travel cancels; the hold's own click
 *   never toggles (`claimTap`).
 * - An explicit "Choose reaction" menu button opens the same pill for
 *   keyboard/screen-reader users (no long-press needed).
 * - The row shows the top-3 preview stack + the total count OUTSIDE the tray;
 *   the tray itself is icon-only (no labels/counts).
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
  const [trayOpener, setTrayOpener] = useState<"main" | "choose" | null>(null);
  const trayOpen = trayOpener !== null;
  // True between the opening pointerdown and its pointerup — the window the
  // slide tracker uses to resolve the hovered kind under the finger.
  const [holding, setHolding] = useState(false);
  const holdingRef = useRef(false);

  const myReaction: ReactionKind | null = love?.myReaction ?? localReaction;
  const myKind = myReaction === null ? null : normalizeReactionKind(myReaction);
  const loved = myKind === "LOVE";
  const active = myKind !== null;
  const summary: ReactionSummary | null =
    love?.summary ?? localSummary ?? seedSummaryFromItem(likeCount, 0, myReaction);
  const total = love?.total ?? summary.total;
  const count = love?.summary || localSummary ? total : (love?.likeCount ?? likeCount);
  const pending = love?.pending ?? localPending;
  const errorId = `home-feed-love-error-${postId}`;
  const mainId = `home-feed-love-button-${postId}`;
  const chooseId = `home-feed-choose-${postId}`;

  const press = useLongPress(() => setTrayOpener("main"), { disabled: pending || trayOpen });
  const slide = useSlideSelect(trayOpen, holding, () => setTrayOpener(null));
  const slideHoverRef = useRef(slide.hovered);
  slideHoverRef.current = slide.hovered;
  const selectKindRef = useRef((_kind: CanonicalReactionKind) => {});
  const closeRef = useRef(() => setTrayOpener(null));

  function failLove() {
    setFailed(true);
    announce("Couldn't save your love. Please try again.");
  }

  function closeTray() {
    slide.reset();
    setTrayOpener(null);
  }
  closeRef.current = closeTray;

  function focusMain() {
    document.getElementById(mainId)?.focus({ preventScroll: true });
  }

  async function onToggle() {
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
  selectKindRef.current = (kind) => {
    void onSelectKind(kind);
  };

  // Slide-release: while the opening finger is still held, a window pointerup
  // over a tray choice selects it. Lifting without sliding leaves the tray
  // open for a follow-up tap (the hold's own click is still swallowed via
  // claimTap); only a vertical-cancel scroll closes without selecting.
  useEffect(() => {
    if (!trayOpen || trayOpener !== "main") return;
    function onUp() {
      const hovered = slideHoverRef.current;
      setHolding(false);
      holdingRef.current = false;
      if (hovered !== null) selectKindRef.current(hovered);
      slide.reset();
    }
    function onCancel() {
      setHolding(false);
      holdingRef.current = false;
      closeRef.current();
    }
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [trayOpen, trayOpener]);

  function markHolding() {
    holdingRef.current = true;
    setHolding(true);
  }

  function clearHolding() {
    holdingRef.current = false;
    setHolding(false);
  }

  const label =
    myKind === null || loved
      ? `${active ? "Loved — tap to unlove this report" : "Love this report"}, ${count} ${count === 1 ? "love" : "loves"}`
      : `${reactionKindLabel(myKind as CanonicalReactionKind)}, ${count} ${count === 1 ? "reaction" : "reactions"}`;

  const showStack = count > 0 && (love?.summary || localSummary || total > 0);

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
          disabled={pending}
          aria-busy={pending}
          onPointerDown={(e) => {
            markHolding();
            press.onPointerDown(e);
          }}
          onPointerMove={press.onPointerMove}
          onPointerUp={() => {
            clearHolding();
            press.onPointerUp();
          }}
          onPointerCancel={() => {
            clearHolding();
            press.onPointerCancel();
          }}
          onClick={() => {
            if (press.claimTap()) return;
            void onToggle();
          }}
          className={`fb-report-action min-h-[44px] min-w-[44px] flex-1 ${active ? "bg-surface-container text-on-surface" : "text-on-surface-variant"}`}
        >
          {showStack ? (
            <>
              <ReactionPreviewStack counts={summary.counts} />
              <span aria-hidden className="tabular-nums">{count}</span>
            </>
          ) : (
            <>
              <ReactionArt kind="LOVE" size={18} filled={active} />
              <span aria-hidden className="tabular-nums">{count}</span>
            </>
          )}
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
            hoveredKind={holding ? slide.hovered : undefined}
            onHoverChange={holding ? slide.setHovered : undefined}
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
