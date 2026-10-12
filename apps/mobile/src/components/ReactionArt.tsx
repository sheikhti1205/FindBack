import type { CanonicalReactionKind } from "@findback/shared";
import { REACTION_KIND_FUNCTIONAL } from "../design/functionalColors";

/**
 * FBX-018 original FindBack reaction artwork (family `findback-reactions-v1`).
 *
 * Four hand-drawn glyphs in one consistent visual family — rounded, friendly,
 * flat fills with a single shared top-left white highlight and one deeper
 * shade for depth. They are NOT Facebook clones, NOT generic Lucide utility
 * icons, NOT monochrome line art, and NOT sticker chaos:
 *
 * - LOVE (`fb-love-heart`): a warm full heart with a soft highlight and a
 *   small gold sparkle — affectionate, never a thin outline.
 * - HELPFUL (`fb-helpful-check`): a rounded-square badge carrying a bold
 *   check — approval / useful insight, never a corporate lightbulb.
 * - SUPPORT (`fb-support-hug`): two overlapping figures with a small rose
 *   heart between them — care / solidarity, readable at 15px.
 * - WOW (`fb-wow-gasp`): a gasping face with wide eyes and an open mouth —
 *   instant surprise read, never a bare sparkle.
 *
 * Each silhouette is distinct (heart / squircle / duo / face) and each kind
 * keeps its W5 functional tint as the base fill (`fill="currentColor"` on
 * the root, colored via the `--fb-reaction-*` var), so the art stays
 * accent-independent and legible on light, dark, and true-black surfaces.
 * Extra decorative tones (white highlight, gold sparkle, rose heart, deep
 * cocoa features) are fixed constants, never accent bindings.
 *
 * The root is `viewBox="0 0 24 24"` scalable: the same art covers the
 * feed-summary tiny stack (~15-16px), the action selected state (~18-20px),
 * the pill large choice (30px), comment tiny rows (15px), and
 * notification/inbox rows. Text-free SVG only — never a system-emoji glyph.
 */

export const REACTION_ART_FAMILY = "findback-reactions-v1" as const;

/** Per-kind marker; tests assert these so generic/monochrome art fails. */
export const REACTION_ART_MARK: Record<CanonicalReactionKind, string> = {
  LOVE: "fb-love-heart",
  HELPFUL: "fb-helpful-check",
  SUPPORT: "fb-support-hug",
  WOW: "fb-wow-gasp",
};

const KIND_COLOR_VAR: Record<CanonicalReactionKind, string> = {
  LOVE: "var(--fb-reaction-love)",
  HELPFUL: "var(--fb-reaction-helpful)",
  SUPPORT: "var(--fb-reaction-support)",
  WOW: "var(--fb-reaction-wow)",
};

function LoveArt() {
  return (
    <g>
      <path d="M12 20.6C7.1 16.9 3.6 13.7 3.6 10.2c0-2.4 1.9-4.3 4.3-4.3 1.6 0 3.1.9 4.1 2.3.9-1.4 2.4-2.3 4.1-2.3 2.4 0 4.3 1.9 4.3 4.3 0 3.5-3.5 6.7-8.4 10.4z" />
      <path
        d="M7.9 5.9c-2.4 0-4.3 1.9-4.3 4.3 0 .6.1 1.1.3 1.7.4-2.1 2.1-3.7 4.2-3.7 1.2 0 2.3.5 3.1 1.3l1-1.3c-1-1.4-2.5-2.3-4.3-2.3z"
        fill="#ffffff"
        opacity="0.28"
      />
      <ellipse
        cx="8.7"
        cy="9.1"
        rx="2.2"
        ry="1.4"
        fill="#ffffff"
        opacity="0.42"
        transform="rotate(-24 8.7 9.1)"
      />
      <path
        d="M17.6 2.6c.32 1.4.92 2 2.32 2.32-1.4.32-2 .92-2.32 2.32-.32-1.4-.92-2-2.32-2.32 1.4-.32 2-.92 2.32-2.32z"
        fill="#ffd98a"
      />
    </g>
  );
}

function HelpfulArt() {
  return (
    <g>
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="6" />
      <rect x="6.2" y="5.4" width="4.6" height="1.7" rx="0.85" fill="#ffffff" opacity="0.35" />
      <path
        d="M7.4 12.5l3.3 3.3 6-6.6"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

function SupportArt() {
  return (
    <g>
      <g opacity="0.45">
        <circle cx="8.4" cy="9.4" r="3" />
        <path d="M2.6 19.4c0-2.9 2.6-4.6 5.8-4.6s5.8 1.7 5.8 4.6v.7a1 1 0 01-1 1H3.6a1 1 0 01-1-1v-.7z" />
      </g>
      <g>
        <circle cx="15.6" cy="9.4" r="3" />
        <path d="M9.8 19.4c0-2.9 2.6-4.6 5.8-4.6s5.8 1.7 5.8 4.6v.7a1 1 0 01-1 1H10.8a1 1 0 01-1-1v-.7z" />
      </g>
      <circle cx="14.7" cy="8.5" r="0.9" fill="#ffffff" opacity="0.5" />
      <path
        d="M12 2.5c-.85-.9-2.4-.6-2.4.65 0 .9 1.25 1.85 2.4 2.7 1.15-.85 2.4-1.8 2.4-2.7 0-1.25-1.55-1.55-2.4-.65z"
        fill="#ff8fa3"
      />
    </g>
  );
}

function WowArt() {
  return (
    <g>
      <circle cx="12" cy="12.4" r="8.6" />
      <path
        d="M6.6 8.4a6.8 6.8 0 015-2.7"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.5"
      />
      <ellipse cx="9.1" cy="10.9" rx="1.2" ry="1.55" fill="#4a2e00" />
      <ellipse cx="14.9" cy="10.9" rx="1.2" ry="1.55" fill="#4a2e00" />
      <circle cx="9.5" cy="10.4" r="0.42" fill="#ffffff" opacity="0.9" />
      <circle cx="15.3" cy="10.4" r="0.42" fill="#ffffff" opacity="0.9" />
      <ellipse cx="12" cy="15.7" rx="2.1" ry="2.6" fill="#4a2e00" />
      <ellipse cx="12" cy="16.5" rx="1" ry="1.2" fill="#8a5a00" opacity="0.65" />
    </g>
  );
}

const KIND_ART: Record<CanonicalReactionKind, () => React.ReactElement> = {
  LOVE: LoveArt,
  HELPFUL: HelpfulArt,
  SUPPORT: SupportArt,
  WOW: WowArt,
};

export function reactionKindColorVar(kind: CanonicalReactionKind): string {
  return KIND_COLOR_VAR[kind];
}

export interface ReactionArtProps {
  kind: CanonicalReactionKind;
  /** Rendered square size in CSS pixels (visual only; hit target stays 44px). */
  size?: number;
  /** When false the art renders muted (empty state); default full color. */
  filled?: boolean;
}

/**
 * Original FindBack reaction art for one kind. Decorative by default
 * (`aria-hidden`) because every call site names the kind on the parent
 * control; pass an explicit `aria-label` via a wrapper when the art itself
 * is the accessible name.
 */
export function ReactionArt({ kind, size = 30, filled = true }: ReactionArtProps) {
  const Art = KIND_ART[kind];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      data-testid={`reaction-art-${kind}`}
      data-kind={kind}
      data-art={REACTION_ART_MARK[kind]}
      data-family={REACTION_ART_FAMILY}
      data-functional-color={REACTION_KIND_FUNCTIONAL[kind]}
      style={{ color: KIND_COLOR_VAR[kind], opacity: filled ? 1 : 0.45 }}
    >
      <Art />
    </svg>
  );
}
