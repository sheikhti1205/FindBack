import type { ComponentType } from "react";
import type { PostItem } from "@findback/shared";
import { CircleAlert, CircleCheck, Link2, Lock } from "lucide-react";

type SemanticStatusKind = "lost" | "found" | "matched" | "recovered" | "closed";

/**
 * Derive the single semantic status chip from existing PostItem fields only —
 * no invented statuses. An OPEN report reads as its type (Lost/Found); any
 * resolved lifecycle state supersedes it (Matched/Recovered/Closed).
 */
function semanticStatus(post: PostItem): { kind: SemanticStatusKind; label: string } {
  switch (post.status) {
    case "MATCHED":
      return { kind: "matched", label: "Matched" };
    case "RECOVERED":
      return { kind: "recovered", label: "Recovered" };
    case "CLOSED":
      return { kind: "closed", label: "Closed" };
    default:
      return post.type === "LOST"
        ? { kind: "lost", label: "Lost" }
        : { kind: "found", label: "Found" };
  }
}

const STATUS_ICONS: Record<SemanticStatusKind, ComponentType<{ size?: number; "aria-hidden"?: boolean }>> = {
  lost: CircleAlert,
  found: CircleCheck,
  matched: Link2,
  recovered: CircleCheck,
  closed: Lock,
};

const STATUS_TONE: Record<SemanticStatusKind, string> = {
  lost: "fb-status-lost",
  found: "fb-status-found",
  matched: "fb-status-matched",
  recovered: "fb-status-recovered",
  closed: "fb-status-closed",
};

/**
 * Canonical semantic status chip: text + icon carry the meaning, never color
 * alone. Extracted verbatim from `PostCardContent` (I4a) so the comment
 * report card reuses one badge renderer; the testid and tone classes do not
 * change for any existing consumer.
 */
export function StatusChip({ post }: { post: PostItem }) {
  const status = semanticStatus(post);
  const Icon = STATUS_ICONS[status.kind];
  return (
    <span
      data-testid="post-status-chip"
      data-status={status.kind}
      className={`fb-type-badge ${STATUS_TONE[status.kind]}`}
    >
      <Icon size={14} aria-hidden />
      {status.label}
    </span>
  );
}
