import type { CanonicalReactionKind } from "@findback/shared";
import { REACTION_KIND_FUNCTIONAL } from "../design/functionalColors";
import { REACTION_EMOJI } from "../services/reactions";

/**
 * Canonical FindBack reaction presentation (owner directive 2026-10-14):
 * platform system-emoji glyphs via the ONE canonical map in
 * `services/reactions.ts` (`REACTION_EMOJI`). No custom SVG/PNG/WebP art —
 * the old `findback-reactions-v1` hand-drawn family is retired.
 *
 * The component name, props (`kind` / `size` / `filled`), and
 * `data-testid="reaction-art-<KIND>"` are stable so feed, detail, comment,
 * tray, preview-stack, and notification callers keep working unchanged.
 */

export const REACTION_ART_FAMILY = "system-emoji" as const;

/**
 * Deprecated alias of the canonical map (custom-art-era marker names kept so
 * old imports resolve). New code must use `REACTION_EMOJI` from
 * `services/reactions.ts`.
 */
export const REACTION_ART_MARK: Record<CanonicalReactionKind, string> = {
  LOVE: "system-emoji-love",
  HELPFUL: "system-emoji-helpful",
  SUPPORT: "system-emoji-support",
  WOW: "system-emoji-wow",
};

const KIND_COLOR_VAR: Record<CanonicalReactionKind, string> = {
  LOVE: "var(--fb-reaction-love)",
  HELPFUL: "var(--fb-reaction-helpful)",
  SUPPORT: "var(--fb-reaction-support)",
  WOW: "var(--fb-reaction-wow)",
};

/** @deprecated System emoji carries its own colors; kept for old imports. */
export function reactionKindColorVar(kind: CanonicalReactionKind): string {
  return KIND_COLOR_VAR[kind];
}

export interface ReactionArtProps {
  kind: CanonicalReactionKind;
  /** Rendered square size in CSS pixels (visual only; hit target stays 44px). */
  size?: number;
  /** When false the emoji renders muted (empty state); default full color. */
  filled?: boolean;
}

/**
 * One canonical system-emoji reaction. Decorative by default (`aria-hidden`)
 * because every call site names the kind on the parent control; pass an
 * explicit `aria-label` via a wrapper when the glyph itself is the
 * accessible name.
 */
export function ReactionArt({ kind, size = 30, filled = true }: ReactionArtProps) {
  return (
    <span
      aria-hidden="true"
      data-testid={`reaction-art-${kind}`}
      data-kind={kind}
      data-family={REACTION_ART_FAMILY}
      data-functional-color={REACTION_KIND_FUNCTIONAL[kind]}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        fontSize: Math.round(size * 0.92),
        lineHeight: 1,
        opacity: filled ? 1 : 0.45,
        filter: filled ? "none" : "grayscale(0.6)",
      }}
    >
      <span aria-hidden="true">{REACTION_EMOJI[kind]}</span>
    </span>
  );
}
