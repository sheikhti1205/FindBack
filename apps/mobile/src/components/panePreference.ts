/**
 * Per-device width/collapse preference for the desktop conversation list pane.
 *
 * Packet `07` asks for a user-resizable pane (about 260–480px, ~320px by
 * default) that collapses to an avatar rail and remembers what this device
 * chose. Nothing here is account data: it is a local layout habit, so it lives
 * in `localStorage` and never syncs.
 *
 * Pure module (no React): the split view owns the DOM, this owns the bounds and
 * the stored shape, so both can be tested without a browser.
 */

export type PanePreference = { width: number; collapsed: boolean };

export type PaneBounds = {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  collapsedWidth: number;
};

/** Packet-07 illustrative bounds, kept in one place for the UI and its tests. */
export const CHAT_PANE: PaneBounds = {
  storageKey: "norfold.chat.pane.v1",
  defaultWidth: 320,
  minWidth: 260,
  maxWidth: 480,
  collapsedWidth: 64,
};

/** Independent local habit for the optional right-hand conversation details. */
export const CHAT_DETAILS_PANE: PaneBounds = {
  storageKey: "norfold.chat.details.v1",
  defaultWidth: 280,
  minWidth: 280,
  maxWidth: 320,
  collapsedWidth: 0,
};

export const DEFAULT_PANE: PanePreference = { width: CHAT_PANE.defaultWidth, collapsed: false };

/** Clamp a dragged/typed width into the pane's allowed range. */
export function clampPaneWidth(width: number, bounds: PaneBounds = CHAT_PANE): number {
  if (!Number.isFinite(width)) return bounds.defaultWidth;
  return Math.min(bounds.maxWidth, Math.max(bounds.minWidth, Math.round(width)));
}

/** Accept only a stored value this build can honour; anything else is default. */
export function parsePanePreference(raw: string | null, bounds: PaneBounds = CHAT_PANE): PanePreference {
  if (!raw) return { ...DEFAULT_PANE, width: bounds.defaultWidth };
  try {
    const value = JSON.parse(raw) as Partial<PanePreference> | null;
    if (!value || typeof value !== "object") return { ...DEFAULT_PANE, width: bounds.defaultWidth };
    const width = typeof value.width === "number" ? clampPaneWidth(value.width, bounds) : bounds.defaultWidth;
    return { width, collapsed: value.collapsed === true };
  } catch {
    return { ...DEFAULT_PANE, width: bounds.defaultWidth };
  }
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // Private mode / blocked storage must not break Chat.
  }
}

export function readPanePreference(bounds: PaneBounds = CHAT_PANE): PanePreference {
  try {
    return parsePanePreference(storage()?.getItem(bounds.storageKey) ?? null, bounds);
  } catch {
    return { ...DEFAULT_PANE, width: bounds.defaultWidth };
  }
}

export function writePanePreference(value: PanePreference, bounds: PaneBounds = CHAT_PANE): void {
  try {
    storage()?.setItem(bounds.storageKey, JSON.stringify({
      width: clampPaneWidth(value.width, bounds), collapsed: value.collapsed === true,
    }));
  } catch {
    // A full or blocked store only loses the habit, never the conversation.
  }
}

/**
 * One keyboard step for the splitter. `coarse` (Shift) jumps further so a long
 * pane does not need dozens of presses; Home/End are handled by the component
 * because they are absolute rather than relative.
 */
export function paneStep(direction: -1 | 1, coarse = false): number {
  return direction * (coarse ? 48 : 16);
}
