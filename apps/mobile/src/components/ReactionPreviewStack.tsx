import type { CanonicalReactionKind, ReactionCounts } from "@findback/shared";
import { CANONICAL_REACTION_KINDS } from "@findback/shared";
import { ReactionArt } from "./ReactionArt";

/**
 * C2 top-3 reaction preview stack (counts live OUTSIDE the tray).
 *
 * Ordered by count descending, ties resolve in canonical tray order
 * (LOVE/HELPFUL/SUPPORT/WOW). Pure icons — the caller renders the total
 * count beside the stack so the tray itself never carries labels or counts.
 */

/** Up to `n` kinds with a positive count, best first. */
export function topReactionKinds(counts: ReactionCounts, n = 3): CanonicalReactionKind[] {
  return CANONICAL_REACTION_KINDS.filter((k) => (counts[k] ?? 0) > 0)
    .sort((a, b) => {
      const diff = (counts[b] ?? 0) - (counts[a] ?? 0);
      if (diff !== 0) return diff;
      return CANONICAL_REACTION_KINDS.indexOf(a) - CANONICAL_REACTION_KINDS.indexOf(b);
    })
    .slice(0, n);
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
