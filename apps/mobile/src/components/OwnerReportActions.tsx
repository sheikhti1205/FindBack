import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { PostItem, PostStatus } from "@findback/shared";
import { POST_STATUSES, POST_STATUS_LABELS, RESOLVED_STATUSES } from "@findback/shared";
import { Copy, MoreVertical, Pencil, Share2, Trash2, Undo2 } from "lucide-react";

/**
 * The owner controls on a My Reports row.
 *
 * The actions live here, not on the card, so the card stays a card: the
 * screen that owns the list owns the handlers, and the row only asks for
 * them. A row rendered outside a provider shows no controls at all.
 */
export interface OwnerReportActionHandlers {
  /** Change the lifecycle status of one of the caller's own reports. */
  onChangeStatus: (post: PostItem, status: PostStatus) => void;
  /** Open the editor for one report. */
  onEdit: (post: PostItem) => void;
  /** Share one report through the canonical share path. */
  onShare: (post: PostItem) => void;
  /** Copy the public link, with the caller's manual fallback when needed. */
  onCopy?: (post: PostItem) => void;
  /** Ask to delete one report. The delete itself is DELAYED — see the screen. */
  onDelete: (post: PostItem) => void;
  /** The report whose delete is waiting for the undo window (null = none). */
  pendingDeleteId?: string | null;
  /** Cancel a pending delete before it is sent. */
  onUndoDelete?: () => void;
}

const OwnerReportActionsContext = createContext<OwnerReportActionHandlers | null>(null);

export function OwnerReportActionsProvider({
  value,
  children,
}: {
  value: OwnerReportActionHandlers;
  children: ReactNode;
}) {
  return (
    <OwnerReportActionsContext.Provider value={value}>{children}</OwnerReportActionsContext.Provider>
  );
}

export function useOwnerReportActions(): OwnerReportActionHandlers | null {
  return useContext(OwnerReportActionsContext);
}

const MENU_ITEM_CLASS =
  "flex w-full min-h-[44px] items-center gap-2 rounded-m3-sm px-3 text-left text-sm font-medium text-on-surface";

function statusLabel(status: PostStatus): string {
  return POST_STATUS_LABELS[status];
}

/**
 * The per-row overflow menu of My Reports.
 *
 * Every action is reachable by tap AND by keyboard: the menu is a real
 * menu with menu items, Escape closes it, the arrow keys move between the
 * items and the focus returns to the trigger when it closes. Swipe is never
 * the only route to an action.
 */
export function OwnerReportMenu({ post }: { post: PostItem }) {
  const actions = useOwnerReportActions();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus();
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (!actions) return null;

  const pending = actions.pendingDeleteId === post.id;

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function run(action: () => void) {
    setOpen(false);
    triggerRef.current?.focus();
    action();
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      // Tab leaves the menu; a non-modal popover must not trap focus.
      setOpen(false);
      return;
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"],[role="menuitemradio"]') ?? [],
    );
    if (items.length === 0) return;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(current + step + items.length) % items.length]?.focus();
  }

  const resolved = RESOLVED_STATUSES.includes(post.status);

  return (
    <div className="relative shrink-0" onPointerDown={(event) => event.stopPropagation()}>
      {pending && (
        <span
          role="status"
          data-testid="owner-report-delete-pending"
          className="mr-1 flex items-center gap-1 rounded-full bg-surface-container px-2 py-1 text-xs font-medium text-on-surface-variant"
        >
          Deleting…
          {actions.onUndoDelete && (
            <button
              type="button"
              onClick={() => actions.onUndoDelete?.()}
              className="flex min-h-[36px] items-center gap-1 rounded-full bg-on-surface px-2 font-semibold text-surface"
              data-testid="owner-report-undo-delete"
            >
              <Undo2 size={13} aria-hidden />
              Undo
            </button>
          )}
        </span>
      )}
      <button
        type="button"
        ref={triggerRef}
        aria-label={`Manage report: ${post.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container"
      >
        <MoreVertical size={18} aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Manage ${post.title}`}
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-20 mt-1 flex max-h-[calc(100dvh-5rem)] w-56 flex-col gap-0.5 overflow-y-auto rounded-m3-md border border-outline-variant bg-surface p-1 shadow-lg"
        >
          <p
            role="presentation"
            className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
          >
            Status
          </p>
          {POST_STATUSES.filter((status) => status !== "RECOVERED" || post.type === "LOST").map((status) => (
            <button
              key={status}
              type="button"
              role="menuitemradio"
              aria-checked={status === post.status}
              onClick={() => run(() => actions.onChangeStatus(post, status))}
              className={MENU_ITEM_CLASS}
            >
              <span className="flex-1">{statusLabel(status)}</span>
              {status === post.status && <span className="text-xs text-on-surface-variant">Current</span>}
            </button>
          ))}
          <hr role="separator" className="my-1 border-outline-variant" />
          <button
            type="button"
            role="menuitem"
            disabled={resolved}
            onClick={() => run(() => actions.onEdit(post))}
            className={`${MENU_ITEM_CLASS} disabled:opacity-50`}
          >
            <Pencil size={16} aria-hidden />
            <span className="flex-1">Edit details</span>
          </button>
          {resolved && (
            <p role="presentation" className="px-3 pb-1 text-xs text-on-surface-variant">
              A recovered or closed report is no longer edited in the app.
            </p>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => run(() => actions.onShare(post))}
            className={MENU_ITEM_CLASS}
          >
            <Share2 size={16} aria-hidden />
            <span className="flex-1">Share</span>
          </button>
          {actions.onCopy && (
            <button
              type="button"
              role="menuitem"
              onClick={() => run(() => actions.onCopy?.(post))}
              className={MENU_ITEM_CLASS}
            >
              <Copy size={16} aria-hidden />
              <span className="flex-1">Copy link</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => run(() => actions.onDelete(post))}
            className={`${MENU_ITEM_CLASS} text-error`}
          >
            <Trash2 size={16} aria-hidden />
            <span className="flex-1">Delete report</span>
          </button>
        </div>
      )}
    </div>
  );
}
