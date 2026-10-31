import { useState } from "react";
import { Flag, Trash2, UserRoundMinus } from "lucide-react";
import { ReportSheet } from "./ReportSheet";
import { BlockControl } from "./BlockControl";
import { ActionMenu, type MenuAction } from "./ActionMenu";
import { AdaptiveTaskSurface } from "./AdaptiveTaskSurface";

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

/** Compact comment overflow, using the canonical anchored action owner.
 * No permission derivation or delete write lives here. Report uses the ONE ReportSheet.
 */
export function CommentSafetyMenu(props: CommentSafetyMenuProps) {
  return <ScopedCommentSafetyMenu key={`${props.viewerId}:${props.commentId}:${props.authorId}`} {...props} />;
}

function ScopedCommentSafetyMenu({ commentId, authorId, authorName, viewerId, canDelete, onDelete, onReported }: CommentSafetyMenuProps) {
  const [reportOpen, setReportOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const mayReport = Boolean(viewerId && viewerId !== authorId);
  const mayDelete = Boolean(viewerId && canDelete && onDelete);

  if (!mayReport && !mayDelete) return null;
  const items: MenuAction[] = [];
  if (mayReport) items.push(
    { id: "report", label: "Report comment", icon: <Flag size={16} aria-hidden="true" />, onAction: () => setReportOpen(true) },
    { id: "block", label: "Block account", icon: <UserRoundMinus size={16} aria-hidden="true" />, onAction: () => setBlockOpen(true) },
  );
  if (mayDelete) items.push({ id: "delete", label: "Delete comment", destructive: true, icon: <Trash2 size={16} aria-hidden="true" />, onAction: () => onDelete?.() });
  return (
    <div className="relative shrink-0">
      <ActionMenu label={`Actions for comment by ${authorName}`} items={items} />
      <ReportSheet open={reportOpen && mayReport} target={{ targetType: "COMMENT", targetId: commentId }} onClose={() => setReportOpen(false)} onReported={onReported} />
      <AdaptiveTaskSurface open={blockOpen && mayReport} title="Block account" onClose={() => setBlockOpen(false)}>
        {blockOpen && <BlockControl userId={authorId} name={authorName} />}
      </AdaptiveTaskSurface>
    </div>
  );
}
