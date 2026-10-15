// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPACT_MAX_PX,
  MASONRY_MAX_COLUMNS,
  MEDIUM_MAX_PX,
  READABLE_COLUMN_CLASS,
  WIDE_CANVAS_CLASS,
  masonryColumns,
  resolveFeedLayout,
  useViewportWidth,
  widthBand,
} from "./responsive";

describe("widthBand", () => {
  it("names the platform bands at their boundaries", () => {
    expect(widthBand(320)).toBe("compact");
    expect(widthBand(COMPACT_MAX_PX - 1)).toBe("compact");
    expect(widthBand(COMPACT_MAX_PX)).toBe("medium");
    expect(widthBand(MEDIUM_MAX_PX - 1)).toBe("medium");
    expect(widthBand(MEDIUM_MAX_PX)).toBe("expanded");
    expect(widthBand(1440)).toBe("expanded");
  });
});

describe("masonryColumns", () => {
  it("never goes below one column on a phone", () => {
    expect(masonryColumns(320)).toBe(1);
    expect(masonryColumns(428)).toBe(1);
  });

  it("fits two columns on a small tablet and three on a tablet", () => {
    expect(masonryColumns(600)).toBe(2);
    expect(masonryColumns(768)).toBe(2);
    expect(masonryColumns(900)).toBe(3);
  });

  it("stops at four columns however wide the viewport gets", () => {
    expect(masonryColumns(1600)).toBe(MASONRY_MAX_COLUMNS);
    expect(masonryColumns(3840)).toBe(MASONRY_MAX_COLUMNS);
  });

  it("keeps every card at or above the comfortable minimum width", () => {
    // The whole point of the cap: a 4-column 900px layout would squeeze cards
    // below the minimum, so the cap must resist it.
    for (const width of [320, 428, 600, 768, 900, 1024, 1280, 1600]) {
      const columns = masonryColumns(width);
      const usable = width - 2 * 12 - (columns - 1) * 12;
      expect(usable / columns).toBeGreaterThanOrEqual(260);
    }
  });
});

describe("resolveFeedLayout", () => {
  it("honours an explicit choice at every width", () => {
    for (const width of [320, 700, 1200]) {
      expect(resolveFeedLayout("feed", width)).toBe("feed");
      expect(resolveFeedLayout("compact", width)).toBe("compact");
      expect(resolveFeedLayout("masonry", width)).toBe("masonry");
    }
  });

  it("picks feed on a phone and masonry only when the viewport is expanded", () => {
    expect(resolveFeedLayout("auto", 390)).toBe("feed");
    expect(resolveFeedLayout("auto", MEDIUM_MAX_PX - 1)).toBe("feed");
    expect(resolveFeedLayout("auto", MEDIUM_MAX_PX)).toBe("masonry");
  });

  it("does not change layout for a few pixels of viewport drift", () => {
    // A band-based rule cannot flap while the user scrolls (packet `09` §6).
    const around = [MEDIUM_MAX_PX - 8, MEDIUM_MAX_PX - 1, MEDIUM_MAX_PX, MEDIUM_MAX_PX + 8];
    const resolved = around.map((w) => resolveFeedLayout("auto", w));
    expect(resolved.filter((r) => r === "masonry")).toHaveLength(2);
  });
});

describe("canvas classes", () => {
  it("expresses the two canvas choices as distinct, non-overlapping classes", () => {
    expect(WIDE_CANVAS_CLASS).not.toContain("max-w-");
    expect(READABLE_COLUMN_CLASS).toContain("max-w-");
    expect(READABLE_COLUMN_CLASS).toContain("mx-auto");
  });
});

describe("useViewportWidth", () => {
  const original = window.innerWidth;
  afterEach(() => {
    window.innerWidth = original;
  });

  it("starts from the real width so the first paint is already correct", () => {
    window.innerWidth = 900;
    const { result } = renderHook(() => useViewportWidth());
    expect(result.current).toBe(900);
  });

  it("follows resizes and stops listening on unmount", () => {
    window.innerWidth = 390;
    const { result, unmount } = renderHook(() => useViewportWidth());
    expect(result.current).toBe(390);

    act(() => {
      window.innerWidth = 1024;
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(1024);

    unmount();
    act(() => {
      window.innerWidth = 600;
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(1024);
  });
});
