/**
 * Masonry placement model: shortest-column packing, stable appends, honest
 * fallbacks for unknown photo sizes.
 */
import { describe, expect, it } from "vitest";
import {
  MASONRY_FALLBACK_RATIO,
  MASONRY_TEXT_BLOCK_PX,
  columnAssignments,
  columnLeft,
  columnWidth,
  estimateMasonryCardHeight,
  masonryAspectRatio,
  placeMasonry,
} from "./masonryLayout";

describe("masonryAspectRatio", () => {
  it("uses the known size when the pair is vouchable", () => {
    expect(masonryAspectRatio({ width: 400, height: 300 })).toBeCloseTo(4 / 3);
    expect(masonryAspectRatio({ width: 300, height: 400 })).toBeCloseTo(0.75);
  });

  it("falls back to the placeholder ratio for unknown or degenerate sizes", () => {
    expect(masonryAspectRatio(null)).toBe(MASONRY_FALLBACK_RATIO);
    expect(masonryAspectRatio({ width: 0, height: 300 })).toBe(MASONRY_FALLBACK_RATIO);
    expect(masonryAspectRatio({ width: 400, height: 0 })).toBe(MASONRY_FALLBACK_RATIO);
    expect(masonryAspectRatio({ width: Number.NaN, height: 300 })).toBe(MASONRY_FALLBACK_RATIO);
  });
});

describe("estimateMasonryCardHeight", () => {
  it("reserves the media box plus the text block", () => {
    expect(estimateMasonryCardHeight({ hasMedia: true, mediaRatio: 1 }, 300)).toBe(
      300 + MASONRY_TEXT_BLOCK_PX,
    );
    // A tall photo (ratio < 1) reserves more than a wide one.
    expect(
      estimateMasonryCardHeight({ hasMedia: true, mediaRatio: 0.5 }, 300),
    ).toBeGreaterThan(estimateMasonryCardHeight({ hasMedia: true, mediaRatio: 2 }, 300));
  });

  it("reserves only the text block when a report has no photo", () => {
    expect(estimateMasonryCardHeight({ hasMedia: false, mediaRatio: 4 / 3 }, 300)).toBe(
      MASONRY_TEXT_BLOCK_PX,
    );
  });
});

describe("placeMasonry", () => {
  const entries = [
    { id: "a", height: 300 },
    { id: "b", height: 100 },
    { id: "c", height: 120 },
  ];

  it("stacks in source order in a single column, with a gap between cards", () => {
    const layout = placeMasonry(entries, { columns: 1, gap: 12 });
    expect(layout.slots.map((s) => s.top)).toEqual([0, 312, 424]);
    expect(layout.slots.every((s) => s.column === 0)).toBe(true);
    // No trailing gap is counted in the container height.
    expect(layout.height).toBe(300 + 12 + 100 + 12 + 120);
  });

  it("packs into the currently shortest column and keeps source order in the DOM", () => {
    const layout = placeMasonry(entries, { columns: 2, gap: 10 });
    expect(layout.slots.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(layout.slots.map((s) => s.column)).toEqual([0, 1, 1]);
    // "b" starts column 1, so "c" is that column's second card.
    expect(layout.slots.map((s) => s.top)).toEqual([0, 0, 110]);
    expect(layout.height).toBe(300);
  });

  it("keeps an existing assignment so an appended page never re-shuffles", () => {
    const first = placeMasonry(entries, { columns: 2, gap: 10 });
    const appended = placeMasonry(
      [...entries, { id: "d", height: 50 }],
      { columns: 2, gap: 10, previous: columnAssignments(first) },
    );
    // The original three keep the exact column and top they already had.
    for (const slot of first.slots) {
      expect(appended.slots.find((s) => s.id === slot.id)).toEqual(slot);
    }
    expect(appended.slots.at(-1)!.id).toBe("d");
    expect(appended.slots.at(-1)!.column).toBe(1);
  });

  it("re-packs when the caller drops the previous map (column count changed)", () => {
    // The caller (FeedMasonry) only hands over assignments captured at the
    // same column count; a resize re-flows everything, so the map is dropped
    // and every card is re-packed from scratch.
    const wide = placeMasonry(entries, { columns: 3, gap: 10 });
    expect(wide.slots.map((s) => s.column)).toEqual([0, 1, 2]);
  });

  it("ignores an out-of-range carried column", () => {
    const stale = new Map([["a", 7]]);
    const layout = placeMasonry(entries, { columns: 2, gap: 10, previous: stale });
    expect(layout.slots[0]!.column).toBe(0);
  });

  it("never drops a card and never trusts a non-finite height", () => {
    const layout = placeMasonry(
      [
        { id: "a", height: Number.NaN },
        { id: "b", height: -5 },
        { id: "c", height: 40 },
      ],
      { columns: 1, gap: 0 },
    );
    expect(layout.slots.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(layout.slots.map((s) => s.height)).toEqual([0, 0, 40]);
    expect(layout.height).toBe(40);
  });

  it("reports an empty layout for no entries and clamps bad column counts", () => {
    expect(placeMasonry([], { columns: 2, gap: 8 })).toEqual({
      slots: [],
      columns: 2,
      height: 0,
    });
    expect(placeMasonry(entries, { columns: 0, gap: 8 }).columns).toBe(1);
  });
});

describe("column geometry", () => {
  it("splits the container into equal columns with gaps", () => {
    expect(columnWidth(2, 620, 12)).toBe(304);
    expect(columnWidth(1, 320, 12)).toBe(320);
    expect(columnLeft(0, 2, 620, 12)).toBe(0);
    expect(columnLeft(1, 2, 620, 12)).toBe(316);
  });

  it("never reports a negative width for a tiny container", () => {
    expect(columnWidth(4, 10, 12)).toBe(0);
    expect(columnLeft(3, 4, 10, 12)).toBe(36);
  });
});
