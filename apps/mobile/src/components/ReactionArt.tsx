import type { CanonicalReactionKind } from "@findback/shared";
import { REACTION_KIND_FUNCTIONAL } from "../design/functionalColors";

/**
 * C2 expressive filled reaction artwork (no emoji-font dependency).
 *
 * Each kind is a filled SVG path (`fill="currentColor"`, no stroke) so the
 * glyph renders identically on every font stack — never a system-emoji
 * glyph. The caller tints via the W5 functional kind var; the component only
 * sets `color` so the art stays accent-independent.
 */

const KIND_COLOR_VAR: Record<CanonicalReactionKind, string> = {
  LOVE: "var(--fb-reaction-love)",
  HELPFUL: "var(--fb-reaction-helpful)",
  SUPPORT: "var(--fb-reaction-support)",
  WOW: "var(--fb-reaction-wow)",
};

function LovePath() {
  return (
    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
  );
}

function HelpfulPath() {
  return (
    <path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z" />
  );
}

function SupportPath() {
  return (
    <path d="M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 3-1.34 3-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
  );
}

function WowPath() {
  return (
    <path d="M12 2c.6 4.5 3.5 7.4 8 8-4.5.6-7.4 3.5-8 8-.6-4.5-3.5-7.4-8-8 4.5-.6 7.4-3.5 8-8zm7 11c.3 2.2 1.7 3.6 3.9 3.9-2.2.3-3.6 1.7-3.9 3.9-.3-2.2-1.7-3.6-3.9-3.9 2.2-.3 3.6-1.7 3.9-3.9zM5 3l1.2 2.8L9 7l-2.8 1.2L5 11l-1.2-2.8L1 7l2.8-1.2L5 3zm14 14l.9 2.1L22 20l-2.1.9L19 23l-.9-2.1L16 20l2.1-.9L19 17z" />
  );
}

const KIND_PATHS: Record<CanonicalReactionKind, () => React.ReactElement> = {
  LOVE: LovePath,
  HELPFUL: HelpfulPath,
  SUPPORT: SupportPath,
  WOW: WowPath,
};

export function reactionKindColorVar(kind: CanonicalReactionKind): string {
  return KIND_COLOR_VAR[kind];
}

export interface ReactionArtProps {
  kind: CanonicalReactionKind;
  /** Rendered square size in CSS pixels (visual only; hit target stays 44px). */
  size?: number;
  /** When false the glyph renders muted (empty state); default filled color. */
  filled?: boolean;
}

/**
 * Single filled reaction glyph. Decorative by default (`aria-hidden`) because
 * every call site names the kind on the parent control; pass an explicit
 * `aria-label` via a wrapper when the art itself is the accessible name.
 */
export function ReactionArt({ kind, size = 30, filled = true }: ReactionArtProps) {
  const Path = KIND_PATHS[kind];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      data-testid={`reaction-art-${kind}`}
      data-kind={kind}
      data-functional-color={REACTION_KIND_FUNCTIONAL[kind]}
      style={{ color: KIND_COLOR_VAR[kind], opacity: filled ? 1 : 0.45 }}
    >
      <Path />
    </svg>
  );
}
