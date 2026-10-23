import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { haptic } from "../utils/haptics";
import { shouldReduceMotion } from "./uiMotion";

/**
 * The owner-row swipe surface.
 *
 * A horizontal swipe reveals ONE lifecycle action behind the row; the same
 * action is always available in the overflow menu, so the gesture is never
 * the only route (accessibility parity). Vertical movement cancels the
 * gesture immediately: the row must keep scrolling like a normal feed row.
 * The action is revealed, not fired, so a stray swipe cannot change a report.
 *
 * Haptics are best-effort at the threshold and on reveal. A platform without
 * vibration simply gets no confirmation.
 */
export interface OwnerStatusSwipeProps {
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

const REVEAL_PX = 88;
const THRESHOLD_PX = 44;
const AXIS_LOCK_PX = 8;

export function OwnerStatusSwipe({
  actionLabel,
  onAction,
  disabled = false,
  className,
  children,
}: OwnerStatusSwipeProps) {
  const [offset, setOffset] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const axis = useRef<"none" | "horizontal" | "vertical">("none");
  const crossed = useRef(false);
  const suppressClick = useRef(false);
  const reduce = shouldReduceMotion();

  function close() {
    setRevealed(false);
    setOffset(0);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (disabled) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    start.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    axis.current = "none";
    crossed.current = false;
    suppressClick.current = false;
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const origin = start.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (axis.current === "none") {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        // Vertical wins: release the row to the scroller and forget the gesture.
        axis.current = "vertical";
        start.current = null;
        return;
      }
      axis.current = "horizontal";
      suppressClick.current = true;
      setDragging(true);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is an enhancement; the gesture still works without it.
      }
    }
    if (axis.current !== "horizontal") return;
    const base = revealed ? -REVEAL_PX : 0;
    const next = Math.max(-REVEAL_PX, Math.min(0, base + dx));
    setOffset(next);
    if (!crossed.current && Math.abs(next) >= THRESHOLD_PX) {
      crossed.current = true;
      haptic("threshold");
    }
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const origin = start.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    start.current = null;
    if (axis.current !== "horizontal") {
      setDragging(false);
      return;
    }
    setDragging(false);
    const open = Math.abs(offset) >= THRESHOLD_PX;
    setRevealed(open);
    setOffset(open ? -REVEAL_PX : 0);
    if (open) haptic("commit");
  }

  function cancel() {
    start.current = null;
    setDragging(false);
    setRevealed(false);
    setOffset(0);
  }

  const transition = dragging || reduce ? "none" : "transform 160ms ease-out";

  return (
    <div
      data-testid="owner-status-swipe"
      data-revealed={revealed}
      className={`relative overflow-hidden rounded-[18px] ${className ?? ""}`}
    >
      <div className="absolute inset-y-0 right-0 flex" aria-hidden={!revealed}>
        <button
          type="button"
          tabIndex={revealed ? 0 : -1}
          onClick={() => {
            close();
            onAction();
          }}
          className="flex w-[88px] min-w-[88px] max-w-[88px] flex-col items-center justify-center gap-1 break-words bg-primary px-2 text-center text-xs font-semibold text-on-primary"
        >
          {actionLabel}
        </button>
      </div>
      <div
        data-testid="owner-status-swipe-surface"
        className="relative touch-pan-y"
        style={{ transform: `translateX(${offset}px)`, transition }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={cancel}
        // A mouse drag that starts on the card's link must not become a
        // native link drag; the horizontal gesture belongs to the row.
        onDragStart={(event) => event.preventDefault()}
        onClickCapture={(event) => {
          if (!suppressClick.current) return;
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div data-testid="owner-status-swipe-content" inert={revealed}>
          {children}
        </div>
        {revealed && (
          <button
            type="button"
            aria-label="Close status actions"
            onClick={close}
            className="absolute inset-0 z-10 rounded-[18px]"
          />
        )}
      </div>
    </div>
  );
}
