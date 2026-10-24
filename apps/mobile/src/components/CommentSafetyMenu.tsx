import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Flag, MoreVertical, Trash2, UserRoundMinus } from "lucide-react";
import { ReportSheet } from "./ReportSheet";
import { BlockControl } from "./BlockControl";
import { BottomSheet } from "./BottomSheet";

export interface CommentSafetyMenuProps {
  commentId: string;
  authorId: string;
  authorName: string;
  viewerId: string | null;
  /** Caller-owned permission hint only; the delete service MUST authorize again. */
  canDelete: boolean;
  /** Opens the parent's existing confirmation/undo + server-backed delete flow. */
  onDelete?: () => void;
  /** Server-confirmed receipt: parent discards stale content and refetches. */
  onReported?: () => void;
}

/** Compact comment overflow, using OwnerReportMenu's non-modal keyboard pattern.
 * No permission derivation or delete write lives here. Report uses the ONE ReportSheet.
 */
export function CommentSafetyMenu(props: CommentSafetyMenuProps) {
  return <ScopedCommentSafetyMenu key={`${props.viewerId}:${props.commentId}:${props.authorId}`} {...props} />;
}

function ScopedCommentSafetyMenu({ commentId, authorId, authorName, viewerId, canDelete, onDelete, onReported }: CommentSafetyMenuProps) {
  const [open, setOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const mayReport = Boolean(viewerId && viewerId !== authorId);
  const mayDelete = Boolean(viewerId && canDelete && onDelete);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (trigger.current?.contains(event.target as Node) || menu.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Tab") { setOpen(false); return; }
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case "Home": next = 0; break;
      case "End": next = items.length - 1; break;
      case "ArrowDown": next = (index + 1) % items.length; break;
      case "ArrowUp": next = (index - 1 + items.length) % items.length; break;
      default: return;
    }
    event.preventDefault();
    items[next]?.focus();
  };

  if (!mayReport && !mayDelete) return null;
  const itemClass = "flex min-h-[44px] w-full items-center gap-2 rounded-m3-sm px-3 text-start text-sm hover:bg-surface-container";
  return (
    <div className="relative shrink-0">
      <button ref={trigger} type="button" aria-label={`Actions for comment by ${authorName}`}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container">
        <MoreVertical size={16} aria-hidden="true" />
      </button>
      {open && (
        <div ref={menu} id={menuId} role="menu" aria-label={`Comment actions for ${authorName}`} onKeyDown={onKeyDown}
          className="absolute end-0 z-20 flex w-44 flex-col rounded-m3-md border border-outline-variant bg-surface p-1 text-on-surface shadow-lg">
          {mayReport && <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); setReportOpen(true); }}>
            <Flag size={16} aria-hidden="true" /> Report comment
          </button>}
          {mayReport && <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); setBlockOpen(true); }}>
            <UserRoundMinus size={16} aria-hidden="true" /> Block account
          </button>}
          {mayDelete && <button type="button" role="menuitem" className={`${itemClass} text-error`} onClick={() => { close(); onDelete?.(); }}>
            <Trash2 size={16} aria-hidden="true" /> Delete comment
          </button>}
        </div>
      )}
      <ReportSheet open={reportOpen && mayReport} target={{ targetType: "COMMENT", targetId: commentId }} onClose={() => setReportOpen(false)} onReported={onReported} />
      <BottomSheet open={blockOpen && mayReport} title="Block account" height="medium" onClose={() => setBlockOpen(false)}>
        {blockOpen && <BlockControl userId={authorId} name={authorName} />}
      </BottomSheet>
    </div>
  );
}
