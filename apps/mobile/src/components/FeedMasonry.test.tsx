// @vitest-environment jsdom
/**
 * FeedMasonry DOM contract (CF-010, packet `09` §6–§9, §24).
 *
 * jsdom has no layout engine, so the two measurement surfaces a browser
 * provides are stubbed on the prototype: the container's `clientWidth` and each
 * card's `getBoundingClientRect().height`. That is the smallest honest stub — it
 * lets the component read the same numbers a real browser would, so the
 * assertions below are about the component's placement rather than about jsdom.
 *
 * The heights are deliberately ragged (120 / 340 / 220): the whole point of the
 * layout is that unequal cards pack instead of every cell being squared off, and
 * the `999` estimate proves the packing used the measured heights.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeedMasonry } from "./FeedMasonry";

interface Item {
  id: string;
  title: string;
}

const ITEMS: Item[] = [
  { id: "a", title: "Keys" },
  { id: "b", title: "Wallet" },
  { id: "c", title: "Umbrella" },
];

/** Measured card heights, by DOM position: three photos of different shapes. */
const MEASURED = [120, 340, 220];
const ESTIMATE = 999;
const CONTAINER_WIDTH = 640;
const GAP = 12;
/** Two columns at 640px: (640 - 12) / 2 = 314 wide, second column starts at 326. */
const COLUMN_WIDTH_2 = 314;
const SECOND_COLUMN_LEFT_2 = 326;
const THIRD_CARD_TOP = 132;

let containerWidth = 0;

function renderGrid(items: Item[] = ITEMS, columns = 2) {
  return render(
    <FeedMasonry
      items={items}
      getKey={(item) => item.id}
      columns={columns}
      estimateHeight={() => ESTIMATE}
      renderItem={(item) => <p>{item.title}</p>}
    />,
  );
}

function items(): HTMLElement[] {
  return Array.from(
    screen.getByTestId("feed-masonry").querySelectorAll<HTMLElement>("[data-testid='feed-masonry-item']"),
  );
}

function measureAt(width: number): void {
  containerWidth = width;
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

beforeEach(() => {
  containerWidth = 0;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === "feed-masonry" ? containerWidth : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      const parent = this.parentElement;
      const index = parent ? Array.from(parent.children).indexOf(this) : -1;
      const height = index >= 0 ? MEASURED[index] ?? 0 : 0;
      return {
        height,
        width: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    },
  });
});

afterEach(() => {
  cleanup();
  // Restore the jsdom originals (on Element.prototype), so no other file in the
  // suite inherits fake geometry.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).getBoundingClientRect;
});

describe("FeedMasonry", () => {
  it("stacks the cards in source order while the container cannot be measured", () => {
    renderGrid();
    const grid = screen.getByTestId("feed-masonry");
    expect(grid.getAttribute("data-measured")).toBe("false");
    expect(items().map((el) => el.textContent)).toEqual(["Keys", "Wallet", "Umbrella"]);
    // No placement at all: an unmeasured grid must never be absolutely placed.
    for (const el of items()) {
      expect(el.getAttribute("data-column")).toBeNull();
      expect(el.className).not.toMatch(/absolute/);
    }
  });

  it("promotes the list to a grid on the first readable width and packs by measured height", () => {
    renderGrid();
    measureAt(CONTAINER_WIDTH);
    const grid = screen.getByTestId("feed-masonry");
    expect(grid.getAttribute("data-measured")).toBe("true");
    expect(grid.getAttribute("data-columns")).toBe("2");
    const placed = items();
    // Shortest-column packing: a→0, b (tallest) →1, c →0 under a.
    expect(placed.map((el) => el.getAttribute("data-column"))).toEqual(["0", "1", "0"]);
    expect(placed[0]!.getAttribute("style")).toMatch(new RegExp(`width:\\s*${COLUMN_WIDTH_2}px`));
    expect(placed[1]!.getAttribute("style")).toContain(`${SECOND_COLUMN_LEFT_2}px`);
    expect(placed[2]!.getAttribute("style")).toContain(`${THIRD_CARD_TOP}px`);
    // The container reserves the tallest column (120 + 12 + 220), so the
    // pagination sentinel has an anchor instead of the page growing a second
    // scrollbar. The 999 estimate would have produced a different number.
    expect(grid.getAttribute("style")).toContain(`${MEASURED[0]! + GAP + MEASURED[2]!}px`);
    // Source order in the DOM is feed order, whatever order the columns are
    // drawn in: a keyboard or screen-reader reader is not misled.
    expect(placed.map((el) => el.textContent)).toEqual(["Keys", "Wallet", "Umbrella"]);
  });

  it("keeps an already-placed card in its column when the next page arrives", () => {
    const { rerender } = renderGrid();
    measureAt(CONTAINER_WIDTH);
    const before = items().map((el) => el.getAttribute("data-column"));
    expect(before).toEqual(["0", "1", "0"]);
    rerender(
      <FeedMasonry
        items={[...ITEMS, { id: "d", title: "Gloves" }]}
        getKey={(item) => item.id}
        columns={2}
        estimateHeight={() => ESTIMATE}
        renderItem={(item) => <p>{item.title}</p>}
      />,
    );
    const after = items().map((el) => el.getAttribute("data-column"));
    expect(after.slice(0, 3)).toEqual(before);
    expect(after).toHaveLength(4);
  });

  it("re-packs when the column count changes", () => {
    const { rerender } = renderGrid();
    measureAt(CONTAINER_WIDTH);
    expect(items()[1]!.getAttribute("style")).toContain(`${SECOND_COLUMN_LEFT_2}px`);
    rerender(
      <FeedMasonry
        items={ITEMS}
        getKey={(item) => item.id}
        columns={3}
        estimateHeight={() => ESTIMATE}
        renderItem={(item) => <p>{item.title}</p>}
      />,
    );
    const grid = screen.getByTestId("feed-masonry");
    expect(grid.getAttribute("data-columns")).toBe("3");
    // (640 - 2*12) / 3 = 205 wide, so the second column no longer starts at 326.
    expect(items()[1]!.getAttribute("style")).not.toContain(`${SECOND_COLUMN_LEFT_2}px`);
  });

  it("places cards without animating them (packet `09` §19/§24)", () => {
    renderGrid();
    measureAt(CONTAINER_WIDTH);
    for (const el of items()) {
      expect(el.className).not.toMatch(/transition|animate|duration|ease|spring/);
    }
  });
});
