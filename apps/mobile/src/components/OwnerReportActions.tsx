import { createContext, useContext, type ReactNode } from "react";
import type { PostItem, PostStatus } from "@norfold/shared";
import { OWNER_SELECTABLE_STATUSES, POST_STATUS_LABELS, RESOLVED_STATUSES } from "@norfold/shared";
import { CircleCheck, Copy, MoreVertical, Pencil, Share2, Trash2, Undo2 } from "lucide-react";
import { ActionMenu, type MenuAction } from "./ActionMenu";

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
  /**
   * Open the durable recovery handover for a lost report.
   *
   * Recovery is a relationship, not a status: it creates the return record that
   * unlocks return counts and ratings. It therefore has its own action and is
   * never offered as a status radio the owner could "set" on its own.
   */
  onRecordRecovery?: (post: PostItem) => void;
  /** Open the canonical linked handover / wrong-match correction controls. */
  onManageMatch?: (post: PostItem) => void;
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

function statusLabel(status: PostStatus): string {
  return POST_STATUS_LABELS[status];
}

/**
 * The per-row overflow menu of My Reports.
 *
 * This is the canonical `ActionMenu`: one anchored layer with collision-aware
 * placement, arrow-key movement, Escape/Back dismissal that returns focus to
 * the trigger, and a destructive row separated from the rest. Swipe is never
 * the only route to an action, and the screen still owns every handler.
 */
export function OwnerReportMenu({ post }: { post: PostItem }) {
  const actions = useOwnerReportActions();
  if (!actions) return null;

  const pending = actions.pendingDeleteId === post.id;
  const resolved = RESOLVED_STATUSES.includes(post.status);
  const matched = post.status === "MATCHED";

  const items: MenuAction[] = [];

  if (matched && actions.onManageMatch) {
    items.push({
      id: "manage-match",
      label: "Match and handover…",
      icon: <CircleCheck size={16} aria-hidden />,
      onAction: () => actions.onManageMatch?.(post),
    });
  }

  // The owner-writable statuses stay one tap away. A live match owns the
  // status, so every entry is disabled rather than offering a write the
  // server would refuse. The current status says so in words, because a
  // plain menu item cannot carry radio state.
  OWNER_SELECTABLE_STATUSES.forEach((status, index) => {
    items.push({
      id: `status-${status}`,
      label: status === post.status ? `${statusLabel(status)} (current)` : statusLabel(status),
      disabled: matched,
      separatorBefore: index === 0,
      onAction: () => actions.onChangeStatus(post, status),
    });
  });

  if (actions.onRecordRecovery && post.type === "LOST" && !resolved && !matched) {
    items.push({
      id: "recovery",
      label: "Record recovery…",
      icon: <CircleCheck size={16} aria-hidden />,
      onAction: () => actions.onRecordRecovery?.(post),
    });
  }

  items.push({
    id: "edit",
    label: resolved ? "Edit details (closed reports can’t be edited)" : "Edit details",
    icon: <Pencil size={16} aria-hidden />,
    disabled: resolved,
    separatorBefore: true,
    onAction: () => actions.onEdit(post),
  });
  items.push({
    id: "share",
    label: "Share",
    icon: <Share2 size={16} aria-hidden />,
    onAction: () => actions.onShare(post),
  });
  if (actions.onCopy) {
    items.push({
      id: "copy",
      label: "Copy link",
      icon: <Copy size={16} aria-hidden />,
      onAction: () => actions.onCopy?.(post),
    });
  }
  items.push({
    id: "delete",
    label: "Delete report",
    icon: <Trash2 size={16} aria-hidden />,
    destructive: true,
    onAction: () => actions.onDelete(post),
  });

  return (
    <div className="flex shrink-0 items-center gap-1" onPointerDown={(event) => event.stopPropagation()}>
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
      <ActionMenu
        label={`Manage report: ${post.title}`}
        items={items}
        icon={<MoreVertical size={18} aria-hidden />}
        triggerClassName="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container"
      />
    </div>
  );
}
