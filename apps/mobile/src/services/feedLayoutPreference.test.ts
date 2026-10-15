// @vitest-environment jsdom
/**
 * CF-010 feed layout preference: the choice persists, syncs, and never invents
 * a layout the reader did not pick.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FEED_LAYOUT,
  FEED_LAYOUT_EVENT,
  FEED_LAYOUT_STORAGE_KEY,
  loadFeedLayout,
  migrateFeedLayout,
  saveFeedLayout,
  useFeedLayoutPreference,
} from "./feedLayoutPreference";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("migrateFeedLayout", () => {
  it("defaults to auto for anything it does not recognise", () => {
    expect(migrateFeedLayout(undefined)).toBe("auto");
    expect(migrateFeedLayout(null)).toBe("auto");
    expect(migrateFeedLayout("")).toBe("auto");
    expect(migrateFeedLayout("grid")).toBe("auto");
    expect(migrateFeedLayout(3)).toBe("auto");
    expect(migrateFeedLayout({ layout: "masonry" })).toBe("auto");
    expect(DEFAULT_FEED_LAYOUT).toBe("auto");
  });

  it("keeps every layout the build knows", () => {
    for (const layout of ["auto", "feed", "compact", "masonry"] as const) {
      expect(migrateFeedLayout(layout)).toBe(layout);
    }
  });
});

describe("load/save", () => {
  it("reads auto when nothing is stored", () => {
    expect(loadFeedLayout()).toBe("auto");
  });

  it("round-trips a stored layout", () => {
    saveFeedLayout("masonry");
    expect(JSON.parse(localStorage.getItem(FEED_LAYOUT_STORAGE_KEY)!)).toBe("masonry");
    expect(loadFeedLayout()).toBe("masonry");
  });

  it("survives corrupt or legacy storage instead of throwing", () => {
    localStorage.setItem(FEED_LAYOUT_STORAGE_KEY, "{not json");
    expect(loadFeedLayout()).toBe("auto");
    localStorage.setItem(FEED_LAYOUT_STORAGE_KEY, JSON.stringify("carousel"));
    expect(loadFeedLayout()).toBe("auto");
  });

  it("announces every save so other mounts re-apply without a reload", () => {
    const seen: unknown[] = [];
    const onSave = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(FEED_LAYOUT_EVENT, onSave);
    saveFeedLayout("compact");
    expect(seen).toEqual(["compact"]);
    window.removeEventListener(FEED_LAYOUT_EVENT, onSave);
  });
});

describe("useFeedLayoutPreference", () => {
  it("starts from storage, so the first paint already has the right layout", () => {
    saveFeedLayout("compact");
    const { result } = renderHook(() => useFeedLayoutPreference());
    expect(result.current.layout).toBe("compact");
  });

  it("persists and updates on setLayout", () => {
    const { result } = renderHook(() => useFeedLayoutPreference());
    expect(result.current.layout).toBe("auto");
    act(() => result.current.setLayout("masonry"));
    expect(result.current.layout).toBe("masonry");
    expect(loadFeedLayout()).toBe("masonry");
  });

  it("follows a save made by another mount", () => {
    const other = renderHook(() => useFeedLayoutPreference());
    const { result } = renderHook(() => useFeedLayoutPreference());
    act(() => other.result.current.setLayout("feed"));
    expect(result.current.layout).toBe("feed");
  });

  it("follows another tab's storage write and ignores unrelated keys", () => {
    const { result } = renderHook(() => useFeedLayoutPreference());
    act(() => {
      localStorage.setItem(FEED_LAYOUT_STORAGE_KEY, JSON.stringify("masonry"));
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: FEED_LAYOUT_STORAGE_KEY,
          newValue: JSON.stringify("masonry"),
        }),
      );
    });
    expect(result.current.layout).toBe("masonry");

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "findback.appearance.v1", newValue: "{}" }),
      );
    });
    expect(result.current.layout).toBe("masonry");
  });

  it("never stores a layout it does not know", () => {
    const { result } = renderHook(() => useFeedLayoutPreference());
    act(() => result.current.setLayout("carousel" as never));
    expect(result.current.layout).toBe("auto");
    expect(loadFeedLayout()).toBe("auto");
  });
});
