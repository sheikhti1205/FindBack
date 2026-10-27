import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Flag, MoreVertical, UserRoundMinus } from "lucide-react";
import { useAuth } from "../auth";
import { ReportSheet } from "./ReportSheet";
import { BlockControl } from "./BlockControl";
import { BottomSheet } from "./BottomSheet";
import type { ReportTargetType } from "../services/moderation";

export interface SafetyActionsProps {
  /**
   * The content being reported, when the surface has one.
   *
   * A post or a comment. A profile has no content, only a person.
   */
  content?: { targetType: Extract<ReportTargetType, "POST" | "COMMENT">; targetId: string };
  /**
   * The person behind the surface, when it is known.
   *
   * A post's author, a comment's author, a message's sender, or the profile's owner. The name is
   * a name — never an id — because it appears in a sentence.
   */
  person?: { userId: string; name: string };
  /**
   * Also offer "report this person".
   *
   * True on a profile: the thing on the surface IS the person. On a post, a comment
   * or a message the content is the subject, and the author/sender is offered the
   * block control instead.
   */
  reportPerson?: boolean;
  className?: string;
}

/**
 * Compact safety overflow for content and public profiles.
 *
 * No new report/block owner: both actions enter the canonical controls.
 * Account and target changes discard open menus/forms. Block membership is
 * read only when the reader opens that action, never on every feed/profile row.
 */
export function SafetyActions(props: SafetyActionsProps) {
  const { user } = useAuth();
  if (!user || user.id === props.person?.userId || (!props.content && !(props.reportPerson && props.person))) return null;
  return <ScopedSafetyActions key={JSON.stringify([user.id, props.content?.targetType, props.content?.targetId, props.person?.userId, props.reportPerson])} {...props} />;
}

function ScopedSafetyActions({ content, person, reportPerson = false, className }: SafetyActionsProps) {
  const [open, setOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const lastItem = useRef(false);
  const menuId = useId();
  const subject = content?.targetType === "COMMENT" ? "comment" : content ? "report" : "profile";
  const target = content ?? (reportPerson && person ? { targetType: "USER" as const, targetId: person.userId } : null);
  const reportLabel = content?.targetType === "COMMENT" ? "Report comment" : content ? "Report post" : "Report user";

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current?.getBoundingClientRect();
    const box = menu.current?.getBoundingClientRect();
    if (!anchor || !box) return;
    setPosition({
      left: Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(anchor.bottom + 4 + box.height <= window.innerHeight - 8 ? anchor.bottom + 4 : anchor.top - box.height - 4, window.innerHeight - box.height - 8)),
    });
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[lastItem.current ? items.length - 1 : 0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismiss = () => close();
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) dismiss(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  const itemClass = "flex min-h-[44px] w-full items-center gap-2 rounded-m3-sm px-3 py-2 text-start text-sm text-on-surface hover:bg-surface-container";
  return (
    <div className={`shrink-0 ${className ?? ""}`} onPointerDown={(event) => event.stopPropagation()}>
      <button ref={trigger} type="button" aria-label={`More ${subject} actions`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container"
        onClick={() => { lastItem.current = false; setOpen((value) => !value); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); lastItem.current = event.key === "ArrowUp"; setOpen(true);
          }
        }}>
        <MoreVertical size={18} aria-hidden="true" />
      </button>
      {open && createPortal(<div ref={menu} id={menuId} role="menu" aria-label={`${subject} safety actions`} onKeyDown={onKeyDown}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}
        style={{ ...position, width: "min(14rem, calc(100vw - 16px))", maxHeight: "calc(100dvh - 16px)" }}
        className="fixed z-50 overflow-y-auto rounded-m3-md border border-outline-variant bg-surface p-1 shadow-lg">
        <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); setReportOpen(true); }}>
          <Flag size={18} className="shrink-0" aria-hidden="true" />{reportLabel}
        </button>
        {person && <button type="button" role="menuitem" className={itemClass} onClick={() => { close(); setBlockOpen(true); }}>
          <UserRoundMinus size={18} className="shrink-0" aria-hidden="true" />Block account
        </button>}
      </div>, document.body)}
      {createPortal(<>
        <ReportSheet open={reportOpen} target={target} onClose={() => setReportOpen(false)} />
        <BottomSheet open={blockOpen} title="Block account" onClose={() => setBlockOpen(false)}>
          {blockOpen && person && <BlockControl userId={person.userId} name={person.name} />}
        </BottomSheet>
      </>, document.body)}
    </div>
  );
}
