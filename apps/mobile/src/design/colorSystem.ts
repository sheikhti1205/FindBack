/**
 * Canonical product palette VALUES. Persistence/application live in appearance;
 * runtime resolution lives in theme; CSS consumes the generated role variables.
 *
 * App surfaces stay neutral (off-white/white, graphite, true black). Functional
 * entries below never define surfaces; the neutral owner is separate. Each is a semantic
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

export type AccentId = "blue" | "indigo" | "violet" | "emerald" | "teal" | "rose" | "orange" | "mono";
export interface AccentOption {
  id: AccentId;
  label: string;
  swatch: string;
  onAccent: string;
  darkSwatch: string;
  darkOnAccent: string;
  container: string;
  darkContainer: string;
}
export const DEFAULT_ACCENT: AccentId = "blue";
export const ACCENT_OPTIONS: readonly AccentOption[] = [
  { id: "blue", label: "Blue", swatch: "#3568d4", onAccent: "#ffffff", darkSwatch: "#adc7ff", darkOnAccent: "#082b60", container: "#e8eeff", darkContainer: "#1c355c" },
  { id: "indigo", label: "Indigo", swatch: "#4350b8", onAccent: "#ffffff", darkSwatch: "#b9c0ff", darkOnAccent: "#1a215e", container: "#e8ebff", darkContainer: "#232a5e" },
  { id: "violet", label: "Violet", swatch: "#7355b7", onAccent: "#ffffff", darkSwatch: "#cfbdff", darkOnAccent: "#2e1a61", container: "#f0eaff", darkContainer: "#38285c" },
  { id: "emerald", label: "Emerald", swatch: "#256c4a", onAccent: "#ffffff", darkSwatch: "#82d5aa", darkOnAccent: "#00391e", container: "#e1f2e8", darkContainer: "#153c29" },
  { id: "teal", label: "Teal", swatch: "#006a6a", onAccent: "#ffffff", darkSwatch: "#7bd8d8", darkOnAccent: "#003838", container: "#ddf2f1", darkContainer: "#153c3c" },
  { id: "rose", label: "Rose", swatch: "#a34763", onAccent: "#ffffff", darkSwatch: "#ffb2c4", darkOnAccent: "#5b112b", container: "#fbe8ef", darkContainer: "#51283a" },
  { id: "orange", label: "Orange", swatch: "#924500", onAccent: "#ffffff", darkSwatch: "#ffb87a", darkOnAccent: "#4a2400", container: "#ffead4", darkContainer: "#4a2a10" },
  { id: "mono", label: "Mono", swatch: "#212529", onAccent: "#ffffff", darkSwatch: "#e9ecef", darkOnAccent: "#212529", container: "#e9ecef", darkContainer: "#343a40" },
];

export interface PrincipalColors {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  link: string;
}
export function accentTokensFor(id: AccentId, mode: "light" | "dark"): PrincipalColors {
  const accent = ACCENT_OPTIONS.find(a => a.id === id) ?? ACCENT_OPTIONS.find(a => a.id === DEFAULT_ACCENT)!;
  return {
    primary: mode === "dark" ? accent.darkSwatch : accent.swatch,
    onPrimary: mode === "dark" ? accent.darkOnAccent : accent.onAccent,
    primaryContainer: mode === "dark" ? accent.darkContainer : accent.container,
    onPrimaryContainer: mode === "dark" ? accent.darkSwatch : accent.darkOnAccent,
    link: mode === "dark" ? accent.darkSwatch : accent.darkOnAccent,
  };
}

const light = {
  surface: "#f8f9fa", low: "#ffffff", container: "#e9ecef", high: "#dee2e6",
  ink: "#212529", secondary: "#495057", outline: "#6c757d", divider: "#ced4da",
  tintInk: "#343a40", bubble: "#e9ecef", action: "#212529",
  hover: "rgba(0, 0, 0, 0.08)", pressed: "rgba(0, 0, 0, 0.12)",
  scrim: "rgba(0, 0, 0, 0.5)",
  shadowSm: "0 1px 2px rgba(0, 0, 0, 0.12)", shadowMd: "0 8px 24px rgba(0, 0, 0, 0.18)",
};
const dark = {
  surface: "#18191b", low: "#202124", container: "#26272b", high: "#2d2f34",
  ink: "#f1f3f5", secondary: "#b7bbc2", outline: "#8b9098", divider: "#34363b",
  tintInk: "#f1f3f5", bubble: "#2d2f34", action: "#f1f3f5",
  hover: "rgba(255, 255, 255, 0.08)", pressed: "rgba(255, 255, 255, 0.12)",
  scrim: "rgba(0, 0, 0, 0.6)",
  shadowSm: "0 1px 2px rgba(0, 0, 0, 0.5)", shadowMd: "0 8px 24px rgba(0, 0, 0, 0.6)",
};
const amoled = {
  ...dark, surface: "#000000",
  shadowSm: "none", shadowMd: "none",
};

export const COLOR_SYSTEM = {
  defaultAccent: DEFAULT_ACCENT,
  neutrals: { light, dark, amoled },
  accents: ACCENT_OPTIONS,
  semantic: {
    lost: FUNCTIONAL_COLORS.lost, found: FUNCTIONAL_COLORS.found,
    matched: FUNCTIONAL_COLORS.matched, recovered: FUNCTIONAL_COLORS.recovered,
    warning: FUNCTIONAL_COLORS.warning, danger: FUNCTIONAL_COLORS.error,
  },
  content: { onMedia: "#ffffff", mention: FUNCTIONAL_COLORS.mentions, link: FUNCTIONAL_COLORS.mentions,
    reaction: { love: FUNCTIONAL_COLORS.love, helpful: FUNCTIONAL_COLORS.helpful,
      support: FUNCTIONAL_COLORS.support, wow: FUNCTIONAL_COLORS.wow } },
  functional: FUNCTIONAL_COLORS,
  onError: { light: "#ffffff", dark: "#690005" },
  success: { light: "#1b5e20", dark: "#a9d6b0" },
} as const;

export type ColorMode = keyof typeof COLOR_SYSTEM.neutrals;

/** Pure role projection, not a theme resolver or preference owner. */
export function colorTokensFor(mode: ColorMode): Record<string, string> {
  const n = COLOR_SYSTEM.neutrals[mode];
  const pair = mode === "light" ? "light" : "dark";
  const f = (id: FunctionalColorId) => FUNCTIONAL_COLORS[id][pair];
  const accent = ACCENT_OPTIONS.find((a) => a.id === DEFAULT_ACCENT)!;
  const tokens: Record<string, string> = {
    "--fb-surface": n.surface, "--fb-surface-container-low": n.low,
    "--fb-surface-container": n.container, "--fb-surface-container-high": n.high,
    "--fb-on-surface": n.ink, "--fb-on-surface-variant": n.secondary,
    "--fb-outline": n.outline, "--fb-outline-variant": n.divider,
    "--fb-primary": `var(--fb-primary-${pair}, ${pair === "light" ? accent.swatch : accent.darkSwatch})`,
    "--fb-on-primary": `var(--fb-on-primary-${pair}, ${pair === "light" ? accent.onAccent : accent.darkOnAccent})`,
    "--fb-primary-container": `var(--fb-primary-container-${pair}, ${pair === "light" ? accent.container : accent.darkContainer})`,
    "--fb-on-primary-container": `var(--fb-on-primary-container-${pair}, ${pair === "light" ? accent.darkOnAccent : accent.darkSwatch})`,
    "--fb-link": `var(--fb-link-${pair}, ${pair === "light" ? accent.darkOnAccent : accent.darkSwatch})`,
    "--fb-primary-hover-layer": n.hover, "--fb-primary-pressed-layer": n.pressed,
    "--fb-focus": "var(--fb-primary)", "--fb-selection": "var(--fb-primary-container)",
    "--fb-on-selection": "var(--fb-on-primary-container)", "--fb-control-active": "var(--fb-primary)",
    "--fb-control-outline": "var(--fb-outline)", "--fb-progress": "var(--fb-primary)",
    "--fb-accent": "var(--fb-primary)", "--fb-accent-ink": "var(--fb-on-primary)",
    "--fb-success": COLOR_SYSTEM.success[pair], "--fb-warning": f("warning").text,
    "--fb-error": f("error").text, "--fb-on-error": COLOR_SYSTEM.onError[pair],
    "--fb-tint-bg": mode === "light" ? n.surface : n.container,
    "--fb-tint-ink": n.tintInk, "--fb-tint-line": n.divider,
    "--fb-status-closed-bg": n.container,
    "--fb-status-closed-ink": mode === "light" ? n.tintInk : n.secondary,
    "--fb-mention": f("mentions").text,
    "--fb-on-media": COLOR_SYSTEM.content.onMedia,
    "--composer-surface": n.low, "--user-bubble": n.bubble, "--assistant-surface": n.surface,
    "--primary-action": n.action, "--scrim": n.scrim, "--shadow-sm": n.shadowSm,
    "--shadow-md": n.shadowMd, "--skeleton-base": n.low === light.low ? n.container : n.low,
    "--skeleton-highlight": mode === "light" ? n.surface : mode === "amoled" ? n.container : n.high,
    "color-scheme": pair,
  };
  for (const id of ["lost", "found", "matched", "recovered"] as const) {
    const prefix = id === "lost" || id === "found" ? `--fb-${id}` : `--fb-status-${id}`;
    tokens[`${prefix}-bg`] = f(id).bg;
    tokens[`${prefix}-ink`] = f(id).ink;
  }
  for (const id of ["love", "helpful", "support", "wow"] as const) tokens[`--fb-reaction-${id}`] = f(id).text;
  for (const [name, id] of Object.entries({ brand: "brand", ai: "ai", notification: "notifications",
    appearance: "appearance", media: "media", privacy: "privacy" } as const)) tokens[`--fb-fc-${name}`] = f(id).text;
  return tokens;
}
