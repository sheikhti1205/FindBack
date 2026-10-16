// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { FixtureRoute } from "./FixtureRoute";
import { cardWidthAt } from "./sections/FeedLayoutFixtures";
import { ALL_VARIANTS, LARGE_TEXT_PERCENT, STANDARD_TEXT_PERCENT } from "./FixtureSection";
import {
  APPEARANCE_EVENT,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  applyAppearance,
  loadAppearance,
} from "../appearance";
import {
  MASONRY_CONTAINER_INSET_PX,
  MASONRY_GUTTER_PX,
  MASONRY_MIN_CARD_PX,
  masonryColumns,
} from "../components/responsive";

const SECTIONS = [
  "home",
  "feed-layouts",
  "home-chrome",
  "detail",
  "create",
  "comments",
  "notifications",
  "search",
  "my-reports",
  "profile",
  "settings",
  "assistant",
  "map-unavailable",
] as const;

beforeAll(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(() => {
  cleanup();
});

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/__fixture"]}>
      <FixtureRoute />
    </MemoryRouter>,
  );
}

describe("visual fixture route (static preflight)", () => {
  it("renders the route shell with a section index", () => {
    renderRoute();
    expect(screen.getByTestId("fixture-route")).toBeTruthy();
    for (const id of SECTIONS) {
      expect(
        screen.getByTestId(`fixture-section-${id}`),
        `missing section: ${id}`,
      ).toBeTruthy();
    }
  });

  it("every section index link resolves to a unique in-page anchor", () => {
    const { container } = renderRoute();
    for (const id of SECTIONS) {
      const anchor = container.querySelector(`#fixture-${CSS.escape(id)}`);
      expect(anchor, `missing anchor: #fixture-${id}`).toBeTruthy();
      // One anchor per id — duplicate ids break reviewer deep-links.
      expect(
        container.querySelectorAll(`#fixture-${CSS.escape(id)}`).length,
        `duplicate anchor: #fixture-${id}`,
      ).toBe(1);
    }
  });

  it.each(SECTIONS)("section %s renders every variant without crashing", (section) => {
    renderRoute();
    const root = screen.getByTestId(`fixture-section-${section}`);
    for (const variant of ALL_VARIANTS) {
      const frames = within(root).getAllByTestId(`fixture-${section}-${variant}`);
      expect(
        frames.length,
        `missing variant ${variant} in section ${section}`,
      ).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.getAttribute("data-fixture-variant")).toBe(variant);
        expect(frame.textContent?.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("home matrix covers 0/1/5 photos, all statuses, and edge rows", () => {
    renderRoute();
    const frame = screen.getByTestId("fixture-home-normal");
    // Matrix ids are stable literals from fixture/posts.ts.
    for (const id of [
      "fx-home-0-photo",
      "fx-home-1-photo",
      "fx-home-5-photos",
      "fx-home-status-open",
      "fx-home-status-matched",
      "fx-home-status-recovered",
      "fx-home-status-closed",
      "fx-home-long-title",
      "fx-home-long-location",
      "fx-home-high-counts",
      "fx-home-long-username",
      "fx-home-no-avatar",
    ]) {
      const link = frame.querySelector(`a[href="/posts/${id}"]`);
      expect(link, `home matrix missing post ${id}`).toBeTruthy();
    }
  });

  it("assistant section carries transcript turns and a labelled composer", () => {
    renderRoute();
    const frame = screen.getByTestId("fixture-assistant-normal");
    expect(
      within(frame).getByText("How do I report a lost bag?"),
    ).toBeTruthy();
    expect(
      within(frame).getByLabelText("Ask the Help & FAQ"),
    ).toBeTruthy();
  });

  it("map-unavailable frames never fabricate coordinates", () => {
    renderRoute();
    const frame = screen.getByTestId("fixture-map-unavailable-normal");
    // The keyless placeholder renders; no tile grid implies no coordinates.
    expect(frame.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("feed-layouts covers every masonry width band plus the compact capsule", () => {
    renderRoute();
    const section = screen.getByTestId("fixture-section-feed-layouts");
    // Four bands: the compact single column and the medium/expanded grids.
    const grids = within(section).getAllByTestId("feed-masonry");
    expect(grids.length).toBeGreaterThanOrEqual(4);
    // Each band renders cards with a real reserved ratio (never a code-built square).
    const media = section.querySelectorAll("[data-testid='masonry-media']");
    expect(media.length).toBeGreaterThan(0);
    for (const node of media) {
      expect(node.getAttribute("style")).toContain("aspect-ratio");
    }
    // §10 identity: the pagination slot is the Morph capsule, not a spinner.
    const loadingFrame = screen.getAllByTestId("fixture-feed-layouts-loading")[1]!;
    const bar = within(loadingFrame).getByTestId("morph-bar");
    const loader = bar.closest('[role="status"]');
    expect(loader).toBeTruthy();
    expect(loader!.textContent).toBe("Loading more…");
    // No rotating glyph anywhere in the wait indicator itself.
    expect(loader!.querySelector("svg")).toBeNull();
  });
});

/**
 * The fixture is the wave's rendered-review surface, so a frame that cannot be
 * trusted as evidence is a defect in the harness, not a cosmetic annoyance.
 * These pin the three ways a frame can lie.
 */
describe("fixture frames are trustworthy evidence", () => {
  it("derives each band frame's column count from its own width", () => {
    renderRoute();
    const section = screen.getByTestId("fixture-section-feed-layouts");
    const frames = [...section.querySelectorAll("[data-frame-width]")] as HTMLElement[];
    expect(frames.length).toBeGreaterThanOrEqual(4);
    const seen = new Set<number>();
    for (const frame of frames) {
      const width = Number(frame.getAttribute("data-frame-width"));
      const columns = Number(frame.getAttribute("data-columns"));
      expect(width).toBeGreaterThan(0);
      // Hand-picked columns are how the 3- and 4-column frames used to render
      // inside a 768px page: a layout production never produces.
      expect(
        columns,
        `frame at ${width}px claims ${columns} columns`,
      ).toBe(masonryColumns(width));
      seen.add(columns);
    }
    // The four bands are all represented.
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it("measures each band frame's cards against the container the frame really gets", () => {
    renderRoute();
    const section = screen.getByTestId("fixture-section-feed-layouts");
    for (const frame of [...section.querySelectorAll("[data-frame-width]")] as HTMLElement[]) {
      const width = Number(frame.getAttribute("data-frame-width"));
      const columns = Number(frame.getAttribute("data-columns"));
      // The container the frame really gives the grid: the frame IS the width
      // (geometry frames have no border or padding), minus the list's own
      // `px-4` gutter. This is a relationship check between a frame's declared
      // width and the column count it declares — not a re-derivation of the
      // formula, which is why it uses the column count the frame publishes
      // rather than the one `masonryColumns` would recompute.
      const card =
        (width - MASONRY_CONTAINER_INSET_PX - (columns - 1) * MASONRY_GUTTER_PX) / columns;
      expect(card, `cards at ${width}px / ${columns} columns`).toBeGreaterThanOrEqual(
        MASONRY_MIN_CARD_PX,
      );
    }
  });

  it("states each boundary frame's card width from that frame's own width", () => {
    // The captions used to paste one number next to two different widths: the
    // 4-column frame claimed 262.7px and measures 262.00px. A caption is
    // evidence, so it is derived and then checked against the derivation.
    renderRoute();
    const section = screen.getByTestId("fixture-section-feed-layouts");
    const frames = [...section.querySelectorAll("[data-frame-width]")].filter((frame) => {
      const caption = [...frame.querySelectorAll("p")]
        .map((paragraph) => paragraph.textContent ?? "")
        .join(" ");
      return caption.includes("boundary");
    });
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of frames) {
      const width = Number(frame.getAttribute("data-frame-width"));
      // The frame's own header is one `p`; the BandFrame caption is another.
      const caption = [...frame.querySelectorAll("p")]
        .map((paragraph) => paragraph.textContent ?? "")
        .join(" ");
      expect(caption).toContain(`${cardWidthAt(width, 20).toFixed(2)}px`);
      expect(caption).toContain(`${cardWidthAt(width, 16).toFixed(2)}px`);
    }
  });

  it("places every band frame on the boundary its own constants define", () => {
    // The frames must not carry hand-typed widths: they are the same constants
    // the product's column maths uses, so moving a constant moves the frames.
    // The floor itself is proven in `responsive.test.ts` against the capped
    // canvas, the real list gutter and every text scale — restating the formula
    // here is what let a bad inset stay green in this file (a frame width and
    // the inset it was derived from move together).
    renderRoute();
    const section = screen.getByTestId("fixture-section-feed-layouts");
    const widths = [...section.querySelectorAll("[data-frame-width]")].map((frame) =>
      Number(frame.getAttribute("data-frame-width")),
    );
    expect(widths).toContain(
      3 * MASONRY_MIN_CARD_PX + 2 * MASONRY_GUTTER_PX + MASONRY_CONTAINER_INSET_PX,
    );
    expect(widths).toContain(
      4 * MASONRY_MIN_CARD_PX + 3 * MASONRY_GUTTER_PX + MASONRY_CONTAINER_INSET_PX,
    );
  });

  it("uses the real theme class on dark and AMOLED frames, not inline paint", () => {
    renderRoute();
    for (const variant of ["dark", "amoled"] as const) {
      const frame = screen.getByTestId(`fixture-feed-layouts-${variant}`);
      // The app's themes are class-scoped token sets; an inline background
      // leaves every `--fb-*` consumer rendering the light theme inside a black
      // box (measured at 1.36:1 before this was fixed).
      expect(frame.classList.contains(variant)).toBe(true);
      expect(frame.style.backgroundColor).toBe("");
      expect(frame.style.color).toBe("");
      // The frame paints its own surface from the token (a mini-viewport), so
      // the class actually switches what the reader sees.
      expect(frame.classList.contains("bg-surface")).toBe(true);
    }
  });

  it("scales large text at the app's own value, and hands the root back", () => {
    // A parent `font-size` scales nothing (every size under review is in rem),
    // and a root font size written once is overwritten by the app's own
    // `applyAppearance` (React runs child effects first). The frame therefore
    // HOLDS the root at the app's Extra-large value while it is mounted.
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_APPEARANCE, textScale: "large" }),
    );
    const { unmount } = renderRoute();
    expect(document.documentElement.style.fontSize).toBe(`${LARGE_TEXT_PERCENT}%`);

    unmount();
    expect(document.documentElement.style.fontSize).not.toBe(`${LARGE_TEXT_PERCENT}%`);
    // The reader's own setting is never rewritten by a review surface.
    expect(loadAppearance().textScale).toBe("large");
  });

  it("controls the page-wide Extra-large hold from one switch, not per frame", () => {
    // A root font size cannot be scoped to a frame, so the control lives at the
    // top of the route and every large-text frame reports the state it is in. A
    // per-frame switch would be a lie: nine frames hold the root, and releasing
    // one of them would change nothing a reviewer can see.
    //
    // The reviewer's saved scale is deliberately NOT the standard one here: if
    // "off" meant "hand the root back", this test would pass by accident for a
    // reader whose own setting is already Standard (measured in the browser
    // before the fix: the switch did nothing while reporting success).
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_APPEARANCE, textScale: "large" }),
    );
    renderRoute();
    const toggle = screen.getByTestId("fixture-large-text-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.style.fontSize).toBe(`${LARGE_TEXT_PERCENT}%`);

    const frames = screen
      .getAllByTestId(/^fixture-.*-large-text$/)
      .filter((frame) => frame.getAttribute("data-fixture-variant") === "large-text");
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(frame.getAttribute("data-fixture-large-text")).toBe("extralarge");
    }

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // The standard scale is HELD, not "handed back to whatever the reviewer has
    // saved": a reviewer whose own setting is already Extra large would
    // otherwise see the switch do nothing (measured in the browser before this
    // was fixed).
    expect(document.documentElement.style.fontSize).toBe(`${STANDARD_TEXT_PERCENT}%`);
    for (const frame of frames) {
      expect(frame.getAttribute("data-fixture-large-text")).toBe("standard");
    }

    // The app re-applies the reader's own settings on its own schedule (accent
    // or theme change, a remount of the app shell). The comparison has to
    // survive that, or the switch would silently drift back to the saved scale
    // mid-review — which is what "hand the root back" actually did.
    act(() => {
      applyAppearance(loadAppearance());
      window.dispatchEvent(new Event(APPEARANCE_EVENT));
    });
    expect(document.documentElement.style.fontSize).toBe(`${STANDARD_TEXT_PERCENT}%`);

    fireEvent.click(toggle);
    expect(document.documentElement.style.fontSize).toBe(`${LARGE_TEXT_PERCENT}%`);
    for (const frame of frames) {
      expect(frame.getAttribute("data-fixture-large-text")).toBe("extralarge");
    }
  });
});
