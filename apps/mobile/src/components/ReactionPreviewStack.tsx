import type { CanonicalReactionKind, ReactionCounts } from "@findback/shared";
import { topKinds } from "../services/reactions";
import { ReactionArt } from "./ReactionArt";

/**
 * C2 top-3 reaction preview stack (counts live OUTSIDE the tray).
 *
 * Ordered by count descending, ties resolve in canonical tray order
 * (LOVE/HELPFUL/SUPPORT/WOW). Pure icons — the caller renders the total
 * count beside the stack so the tray itself never carries labels or counts.
 */

/**
 * Up to `n` kinds with a positive count, best first. Single-source alias
 * over the canonical `topKinds` in `services/reactions.ts` (L-CONSOLIDATE)
 * — kept under this name for existing importers.
 */
export function topReactionKinds(counts: ReactionCounts, n = 3): CanonicalReactionKind[] {
  return topKinds(counts, n);
}

export interface ReactionPreviewStackProps {
  counts: ReactionCounts;
  /** Small icon size (visual only); default 16px with -6px overlap. */
  size?: number;
  max?: number;
}

/**
 * Overlapping filled-art stack. Decorative (`aria-hidden`) — the parent
 * control carries the accessible "Kind, N reactions" label and the visible
 * total, so screen readers never count icons.
 */
export function ReactionPreviewStack({ counts, size = 16, max = 3 }: ReactionPreviewStackProps) {
  const kinds = topReactionKinds(counts, max);
  if (kinds.length === 0) return null;
  return (
    <span
      data-testid="reaction-preview-stack"
      aria-hidden="true"
      className="inline-flex shrink-0 items-center"
    >
      {kinds.map((kind, i) => (
        <span
          key={kind}
          data-testid={`reaction-preview-${kind}`}
          className="rounded-full bg-surface"
          style={{ marginLeft: i === 0 ? 0 : -6, zIndex: kinds.length - i }}
        >
          <ReactionArt kind={kind} size={size} />
        </span>
      ))}
    </span>
  );
}
