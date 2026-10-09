/**
 * W5 canonical functional color map (OWNER_DIRECTIVE W5 — COLOR + APPEARANCE).
 *
 * App surfaces stay neutral (off-white/white, neutral gray, charcoal, true
 * black) — this module NEVER defines a surface. Each entry is a semantic
 * ramp: a chip pair (`bg`/`ink`, AA together) plus a `text` tone that meets
 * AA on every neutral surface of its mode, including true black (`#000000`)
 * for dark. Dark ramps are shared by `.dark` and `.amoled` (true black only
 * changes surfaces, never semantic hues).
 *
 * The user accent (`appearance.ts`) customizes ONLY principal
 * actions/selections. It is deliberately NOT an input here — the resolver
 * takes `(id, mode)` only, so semantic states can never be recolored by the
 * accent. Call sites bind to these ramps via the `--fb-fc-*` CSS vars (see
 * `index.css`); the hex values below are the single source of truth the
 * contrast tests assert against.
 */

export type FunctionalColorMode = "light" | "dark";

export type FunctionalColorId =
  | "brand"
  | "lost"
  | "found"
  | "matched"
  | "recovered"
  | "ai"
  | "notifications"
  | "appearance"
  | "media"
  | "privacy"
  | "mentions"
  | "love"
  | "helpful"
  | "support"
  | "wow"
  | "warning"
  | "error";

export interface FunctionalColorRamp {
  /** Chip/tile fill. */
  bg: string;
  /** Text/icon on top of `bg` (AA vs `bg`). */
  ink: string;
  /** Running text/icon on neutral surfaces (AA vs every neutral surface). */
  text: string;
}

export interface FunctionalColorEntry {
  id: FunctionalColorId;
  label: string;
  light: FunctionalColorRamp;
  dark: FunctionalColorRamp;
  /** Where the ramp may be used; surfaces are always off-limits. */
  usage: string;
}

export const FUNCTIONAL_COLORS: Record<FunctionalColorId, FunctionalColorEntry> = {
  brand: {
    id: "brand",
    label: "Brand / primary",
    light: { bg: "#d8efeb", ink: "#073e35", text: "#0a5a4c" },
    dark: { bg: "#153c3c", ink: "#8fe3e3", text: "#7bd8d8" },
    usage: "Deep green-teal family. Principal brand marks and primary identity on neutral surfaces; never app backgrounds.",
  },
  lost: {
    id: "lost",
    label: "Lost",
    light: { bg: "#fbeed3", ink: "#5c3200", text: "#7a3e00" },
    dark: { bg: "#3a2c00", ink: "#f5c04b", text: "#f0c75e" },
    usage: "Amber/orange status chip + icon for Lost reports on neutral surfaces; never app backgrounds.",
  },
  found: {
    id: "found",
    label: "Found",
    light: { bg: "#ddf0e1", ink: "#123f1f", text: "#1e6b32" },
    dark: { bg: "#12331f", ink: "#9bdcab", text: "#8fdb9f" },
    usage: "Green status chip + icon for Found reports on neutral surfaces; never app backgrounds.",
  },
  matched: {
    id: "matched",
    label: "Matched",
    light: { bg: "#e4e9fc", ink: "#26328a", text: "#3548c8" },
    dark: { bg: "#1c2a5c", ink: "#bec8ff", text: "#bec8ff" },
    usage: "Blue/violet status chip + icon for Matched reports on neutral surfaces; never app backgrounds.",
  },
  recovered: {
    id: "recovered",
    label: "Recovered",
    light: { bg: "#d8f0e6", ink: "#093f2e", text: "#0b6b4f" },
    dark: { bg: "#0e3b2c", ink: "#8fe3c3", text: "#8fe3c3" },
    usage: "Emerald status chip + icon for Recovered reports on neutral surfaces; never app backgrounds.",
  },
  ai: {
    id: "ai",
    label: "AI",
    light: { bg: "#ece5fb", ink: "#3b1f7a", text: "#6a3fd1" },
    dark: { bg: "#38285c", ink: "#dccbff", text: "#cfbdff" },
    usage: "Violet AI badges, icons, and assistant affordances on neutral surfaces.",
  },
  notifications: {
    id: "notifications",
    label: "Notifications",
    light: { bg: "#f8edce", ink: "#4a3500", text: "#7a4a00" },
    dark: { bg: "#46391c", ink: "#f0d089", text: "#e9c46a" },
    usage: "Amber notification dots/badges on neutral surfaces; shares the warning amber ramp.",
  },
  appearance: {
    id: "appearance",
    label: "Appearance",
    light: { bg: "#efe7fa", ink: "#4a2478", text: "#7a3fb0" },
    dark: { bg: "#38285c", ink: "#dccbff", text: "#d9beff" },
    usage: "Purple Appearance settings icons/accents on neutral surfaces.",
  },
  media: {
    id: "media",
    label: "Media",
    light: { bg: "#dff3f5", ink: "#084a52", text: "#0b6e7a" },
    dark: { bg: "#153c3c", ink: "#8fe3e3", text: "#8fe3e3" },
    usage: "Cyan media/photo affordances on neutral surfaces.",
  },
  privacy: {
    id: "privacy",
    label: "Privacy / verified",
    light: { bg: "#ddf0e1", ink: "#123f1f", text: "#1e6b32" },
    dark: { bg: "#12331f", ink: "#9bdcab", text: "#8fdb9f" },
    usage: "Green privacy/verified checks on neutral surfaces; shares the Found green ramp.",
  },
  mentions: {
    id: "mentions",
    label: "Mentions / links",
    light: { bg: "#e4e9fc", ink: "#26328a", text: "#0b57d0" },
    dark: { bg: "#1c2a5c", ink: "#bec8ff", text: "#a8c7fa" },
    usage: "Blue/teal @mention and semantic link color on neutral surfaces; never the user accent.",
  },
  love: {
    id: "love",
    label: "Love",
    light: { bg: "#fbe7ee", ink: "#6e1530", text: "#a62b4d" },
    dark: { bg: "#51283a", ink: "#ffc9d6", text: "#ffb2c4" },
    usage: "Rose/red Love reaction icon + count on neutral surfaces.",
  },
  helpful: {
    id: "helpful",
    label: "Helpful",
    light: { bg: "#e4eafb", ink: "#1e3f8f", text: "#2f5fc6" },
    dark: { bg: "#1c355c", ink: "#c4d6ff", text: "#adc7ff" },
    usage: "Blue Helpful reaction icon + count on neutral surfaces.",
  },
  support: {
    id: "support",
    label: "Support",
    light: { bg: "#d8efeb", ink: "#084e45", text: "#0b6b5b" },
    dark: { bg: "#153c3c", ink: "#8fe3e3", text: "#7bd8d8" },
    usage: "Teal/green Support reaction icon + count on neutral surfaces.",
  },
  wow: {
    id: "wow",
    label: "Wow",
    light: { bg: "#f7ecd0", ink: "#5c3d00", text: "#8a5a00" },
    dark: { bg: "#46391c", ink: "#f0d089", text: "#e9c46a" },
    usage: "Bronze-gold Wow reaction icon + count on neutral surfaces; icon-only, never a status chip.",
  },
  warning: {
    id: "warning",
    label: "Warning",
    light: { bg: "#f8edce", ink: "#4a3500", text: "#755400" },
    dark: { bg: "#46391c", ink: "#f0d089", text: "#e9c46a" },
    usage: "Amber warning text/badges on neutral surfaces; mirrors --fb-warning.",
  },
  error: {
    id: "error",
    label: "Delete / error",
    light: { bg: "#f9dedc", ink: "#5c0805", text: "#ba1a1a" },
    dark: { bg: "#3a2325", ink: "#ffc9c2", text: "#ffb4ab" },
    usage: "Red destructive/error text and badges on neutral surfaces; mirrors --fb-error.",
  },
};

/**
 * Why Wow is bronze-gold: the directive assigns every other vivid family
 * (rose Love, blue Helpful, teal-green Support, violet AI, cyan media) and
 * omits Wow. Bronze-gold reads as delight/surprise without colliding with
 * Lost-amber status because Wow is ICON-ONLY inside the reaction tray —
 * always paired with the Sparkles glyph and the "Wow" label, never rendered
 * as a status chip or background. Sharing the amber ramp with
 * warnings/notifications is safe for the same reason: shape + label carry
 * the meaning, and the tray context is unambiguous.
 */
export const WOW_RATIONALE =
  "Wow renders icon-only (Sparkles glyph + label + count) in restrained bronze-gold; " +
  "it is never a status chip or background, so sharing the amber ramp cannot collide with Lost/warning states.";

/** Reaction kind → functional color. LIKE normalizes to LOVE upstream. */
export const REACTION_KIND_FUNCTIONAL = {
  LOVE: "love",
  HELPFUL: "helpful",
  SUPPORT: "support",
  WOW: "wow",
} as const satisfies Record<string, FunctionalColorId>;

/** Mention/profile links bind to the blue/teal family, never the accent. */
export const MENTION_FUNCTIONAL_ID = "mentions" satisfies FunctionalColorId;

/**
 * Mode resolver. Takes no accent — semantic colors are accent-independent by
 * construction. Callers needing CSS should prefer the `--fb-fc-*` vars.
 */
export function functionalColorFor(id: FunctionalColorId, mode: FunctionalColorMode): FunctionalColorRamp {
  return FUNCTIONAL_COLORS[id][mode];
}
