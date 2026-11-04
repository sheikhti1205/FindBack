// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_PANE, clampPaneWidth, paneStep, parsePanePreference, readPanePreference, writePanePreference,
} from "./panePreference";

const KEY = CHAT_PANE.storageKey;

beforeEach(() => { globalThis.localStorage?.clear(); });
afterEach(() => { globalThis.localStorage?.clear(); });

describe("the conversation pane preference", () => {
  it("clamps to the packet bounds instead of trusting a stored or dragged number", () => {
    expect(clampPaneWidth(320)).toBe(320);
    expect(clampPaneWidth(10)).toBe(CHAT_PANE.minWidth);
    expect(clampPaneWidth(9999)).toBe(CHAT_PANE.maxWidth);
    expect(clampPaneWidth(Number.NaN)).toBe(CHAT_PANE.defaultWidth);
    expect(clampPaneWidth(319.6)).toBe(320);
  });

  it("falls back to the default for missing, malformed or foreign-shaped values", () => {
    const fallback = { width: CHAT_PANE.defaultWidth, collapsed: false };
    expect(parsePanePreference(null)).toEqual(fallback);
    expect(parsePanePreference("{not json")).toEqual(fallback);
    expect(parsePanePreference(JSON.stringify({ width: "wide" }))).toEqual(fallback);
    expect(parsePanePreference(JSON.stringify({ width: 900, collapsed: "yes" })))
      .toEqual({ width: CHAT_PANE.maxWidth, collapsed: false });
    expect(parsePanePreference(JSON.stringify({ width: 300, collapsed: true })))
      .toEqual({ width: 300, collapsed: true });
  });

  it("remembers the width and collapse state on this device", () => {
    expect(readPanePreference()).toEqual({ width: CHAT_PANE.defaultWidth, collapsed: false });
    writePanePreference({ width: 999, collapsed: true });
    expect(readPanePreference()).toEqual({ width: CHAT_PANE.maxWidth, collapsed: true });
    expect(JSON.parse(globalThis.localStorage.getItem(KEY) ?? "null"))
      .toEqual({ width: CHAT_PANE.maxWidth, collapsed: true });
  });

  it("ignores a stored value that a smaller window would have written", () => {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ width: 100, collapsed: false }));
    expect(readPanePreference().width).toBe(CHAT_PANE.minWidth);
  });

  it("steps further when the user holds Shift", () => {
    expect(paneStep(1)).toBe(16);
    expect(paneStep(-1)).toBe(-16);
    expect(paneStep(1, true)).toBe(48);
    expect(paneStep(-1, true)).toBe(-48);
  });
});
