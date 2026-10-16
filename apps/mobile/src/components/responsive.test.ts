// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPACT_MAX_PX,
  MASONRY_CONTAINER_INSET_PX,
  MASONRY_GUTTER_PX,
  MASONRY_MAX_COLUMNS,
  MASONRY_MIN_CARD_PX,
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
    //
    // This asserts against the CONTAINER the feed really gets — viewport minus
    // the list's own `px-4` — not against a restatement of the formula's own
    // budget. The restatement is what let the formula claim 260px cards while
    // the rendered card at the 3-column boundary was 256.7px.
    for (let width = 320; width <= 1600; width += 1) {
      const columns = masonryColumns(width);
      const container = width - MASONRY_CONTAINER_INSET_PX;
      const card = (container - (columns - 1) * MASONRY_GUTTER_PX) / columns;
      expect(card, `cards at ${width}px / ${columns} columns`).toBeGreaterThanOrEqual(
        MASONRY_MIN_CARD_PX,
      );
    }
  });

  it("changes column count exactly where the container stops fitting another card", () => {
    // Boundary widths, derived from the container budget rather than restated:
    // n cards of 260px and n-1 gutters must fit the container.
    const boundary = (columns: number) =>
      columns * MASONRY_MIN_CARD_PX + (columns - 1) * MASONRY_GUTTER_PX + MASONRY_CONTAINER_INSET_PX;
    expect(masonryColumns(boundary(2) - 1)).toBe(1);
    expect(masonryColumns(boundary(2))).toBe(2);
    expect(masonryColumns(boundary(3) - 1)).toBe(2);
    expect(masonryColumns(boundary(3))).toBe(3);
    expect(masonryColumns(boundary(4) - 1)).toBe(3);
    expect(masonryColumns(boundary(4))).toBe(4);
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
