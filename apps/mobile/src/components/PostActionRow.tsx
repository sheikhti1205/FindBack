import type { ReactNode } from "react";
import { Link } from "react-router";
import { MessageSquare } from "lucide-react";
import "./PostActionRow.css";

/**
 * The compact flat action row (owner reference: a single row of icon-only
 * actions — heart + count, comment bubble + count, share arrow, bookmark at
 * the end — followed by nothing else).
 *
 * WHY SLOTS AND NOT PROPS: the reaction state owner differs per surface. The
 * home feed's Like control lives in `HomeFeedLoveButton` (feed reaction
 * provider), the detail screen owns its own. This component therefore NEVER
 * owns, fetches or re-implements reaction state — it only lays the controls
 * out flat and guarantees the row's own affordances (the comment control with
 * its visible + announced count).
 *
 * WHY THE CSS FILE: `.fb-report-action` is unlayered plain CSS in
 * `index.css`, and unlayered rules beat every Tailwind utility regardless of
 * specificity (Tailwind utilities live in `@layer utilities`). The flat look
 * — no border, no fill, no button card, the count inline with the icon —
 * therefore cannot be expressed with utilities on the slotted controls; it
 * needs one scoped, higher-specificity rule instead of an `!important` pile.
 */
export interface PostActionRowSlots {
  /** The caller's own Like control (its state owner stays with the caller). */
  like: ReactNode;
  /** Optional Save/bookmark control — another lane owns that component and slots it in. */
  save?: ReactNode;
  /** Called when the comment affordance is activated. */
  onComments?: () => void;
  /** Share control (the caller slots the existing share button in). */
  share?: ReactNode;
}

export interface PostActionRowProps {
  slots: PostActionRowSlots;
  commentCount: number;
  className?: string;
  /**
   * Extension to the base contract: when set, the comment affordance renders
   * as a router link to that destination (the home feed deep-links to
   * `/posts/:id#detail-comments`, which keeps middle-click / open-in-new-tab
   * and the link role). When it is unset the affordance is a button that calls
   * `slots.onComments` — the shape a screen that only wants to move focus to
   * its own comment box uses.
   */
  commentsHref?: string;
}

/**
 * One horizontal row of icon-only actions. Nothing in it is a pill, a filled
 * chip or a text label: the icons carry the meaning, the counts are visible
 * next to their icon, and every control keeps a >=44px hit area.
 */
export function PostActionRow({ slots, commentCount, className, commentsHref }: PostActionRowProps) {
  const commentLabel = `Comments, ${commentCount}`;
  const commentControl = (
    <>
      <MessageSquare size={18} aria-hidden />
      <span className="tabular-nums">{commentCount}</span>
    </>
  );
  return (
    <div
      data-testid="post-action-row"
      role="group"
      aria-label="Report actions"
      className={`fb-post-action-row flex min-w-0 flex-nowrap items-center gap-0.5${
        className ? ` ${className}` : ""
      }`}
    >
      {slots.like}
      {commentsHref ? (
        <Link to={commentsHref} aria-label={commentLabel} className="fb-report-action">
          {commentControl}
        </Link>
      ) : (
        <button
          type="button"
          onClick={slots.onComments}
          disabled={!slots.onComments}
          aria-label={commentLabel}
          className="fb-report-action"
        >
          {commentControl}
        </button>
      )}
      {slots.share}
      {slots.save}
    </div>
  );
}
