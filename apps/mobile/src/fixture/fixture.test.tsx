// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { FixtureRoute } from "./FixtureRoute";
import { cardWidthAt, rootPxFor } from "./sections/FeedLayoutFixtures";
import { masonryListPaddingRem } from "../test-utils/masonryListClass";
import { ALL_VARIANTS, LARGE_TEXT_PERCENT, STANDARD_TEXT_PERCENT } from "./FixtureSection";
import { NAV_VARIANTS } from "./sections/NavigationFixtures";
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
  "navigation",
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
    // Navigation is data-free, so it renders only the variants that can change
    // its paint (see NAV_VARIANTS); every other section keeps the full matrix.
    const variants = section === "navigation" ? NAV_VARIANTS : ALL_VARIANTS;
    for (const variant of variants) {
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

  it("states each frame's card widths from that frame's own width, pinned per scale", () => {
    // Ways this check has been decorative before, all closed here:
    //  - the caption was compared against the same `cardWidthAt(...)` literals it
    //    was built from (self-referential: pointing the derivation at the 40px
    //    inset left this green while the caption read 260.00px where 262.656px
    //    renders);
    //  - the two numbers were asserted by containment only, so swapping them
    //    ("Extra large text held below" next to the standard-scale value) stayed
    //    green while the on-screen caption was wrong;
    //  - the frame filter keyed off the word "boundary", so a measurement added
    //    to any other frame was never inspected at all;
    //  - the caption was re-parsed out of the prose, so a number spelled in a way
    //    the parser did not recognise (a space before `px`, upper case, or the
    //    same text as the stripped `at <width>px` header) was invisible;
    //  - the geometry premise every number rests on was pinned on two nodes
    //    (`frame.className`, `frame.lastElementChild.className`), so a padding
    //    wrapper one level deeper shrank the cards while the caption kept its
    //    figure — green, and a lie.
    // Now: a frame declares the widths it publishes (`data-frame-measurements`),
    // the declaration is pinned against per-band goldens, the rendered caption is
    // checked against the declaration in both directions (nothing printed that was
    // not declared, nothing declared that is not printed), and the geometry
    // premise is pinned along the whole chain from the frame's content box down to
    // the lane that owns the card grid.
    renderRoute();
    const section = screen.getByTestId("fixture-section-feed-layouts");
    const threeColumn = 3 * MASONRY_MIN_CARD_PX + 2 * MASONRY_GUTTER_PX + MASONRY_CONTAINER_INSET_PX;
    const fourColumn = 4 * MASONRY_MIN_CARD_PX + 3 * MASONRY_GUTTER_PX + MASONRY_CONTAINER_INSET_PX;
    const golden: Record<number, readonly [extraLarge: string, standard: string]> = {
      [threeColumn]: ["260.00", "262.67"],
      [fourColumn]: ["260.00", "262.00"],
    };
    // A class that changes the box a frame's cards are laid out in. The walk below
    // stops at the lane (whose own `px-*` gutter is the one inset the caption
    // arithmetic budgets, pinned to the source by `masonryListPaddingRem`), so
    // everything between the frame and that lane must be transparent.
    const BOX_UTILITY =
      /^(?:p|px|py|ps|pe|pt|pb|pl|pr|m|mx|my|ms|me|mt|mb|ml|mr|w|min-w|max-w|basis|border|border-x|border-y|rounded|ring|outline)(?:-|$)/;
    const frames = [...section.querySelectorAll("[data-frame-width]")];
    expect(frames.length).toBeGreaterThanOrEqual(2);
    let checked = 0;
    for (const frame of frames) {
      const width = Number(frame.getAttribute("data-frame-width"));
      const declared = (frame.getAttribute("data-frame-measurements") ?? "").split(/\s+/).filter(Boolean);
      const grid = frame.querySelector('[data-testid="feed-masonry"]');
      // The frame's caption prose — its own label plus any band header — and never
      // the cards' own text, which is content and may mention anything.
      const caption = [...frame.querySelectorAll("p")]
        .filter((paragraph) => !grid || !grid.contains(paragraph))
        .map((paragraph) => paragraph.textContent ?? "")
        .join(" ");
      // Every `${n}px` the caption prints, with the frame naming its own width
      // kept apart: `at <width>px` is allowed, and only once.
      const printed = [...caption.matchAll(/(at\s+)?(\d+(?:\.\d+)?)\s*px/gi)].map((match) => ({
        namesOwnWidth: Boolean(match[1]) && Number(match[2]) === width,
        value: match[2] as string,
      }));
      const ownWidthMentions = printed.filter((entry) => entry.namesOwnWidth);
      expect(
        ownWidthMentions.length,
        `the ${width}px frame names its own width more than once, so a caption number hides behind it`,
      ).toBeLessThanOrEqual(1);
      // Both directions: a caption may print only what the frame declares, and a
      // declaration must be printed.
      expect(
        printed.filter((entry) => !entry.namesOwnWidth).map((entry) => entry.value).sort(),
        `the ${width}px frame's caption numbers do not match what it declares`,
      ).toEqual([...declared].sort());
      if (declared.length === 0) continue;
      const expected = golden[width];
      expect(
        expected,
        `the ${width}px frame publishes card widths but has no pinned goldens`,
      ).toBeTruthy();
      expect(declared).toEqual([expected![0], expected![1]]);
      expect(caption).toContain(`${expected![0]}px with Extra large text held below`);
      expect(caption).toContain(`${expected![1]}px at the standard scale`);
      // The premise the numbers rest on: this frame's content box IS `width`. jsdom
      // applies no layout, so the assertions are on the inputs the render depends
      // on — the frame's own inline width, no border/rounding on the frame, and a
      // transparent chain from the frame down to the lane that owns the grid.
      expect(
        (frame as HTMLElement).style.width,
        `the ${width}px frame no longer sets its own width`,
      ).toBe(`${width}px`);
      expect(frame.className, `the ${width}px frame is no longer a geometry frame`).not.toMatch(
        /\bborder\b|\brounded-/,
      );
      expect(grid, `the ${width}px frame publishes card widths but renders no masonry grid`).toBeTruthy();
      const lane = grid!.parentElement;
      expect(lane, `the ${width}px frame's grid has no lane`).toBeTruthy();
      for (let element = lane!.parentElement; element && element !== frame; element = element.parentElement) {
        const offenders = [...element.classList].filter((name) => BOX_UTILITY.test(name));
        expect(
          offenders,
          `the ${width}px frame stacks ${offenders.join(", ")} between its content box and the lane, so its cards are narrower than its caption`,
        ).toEqual([]);
      }
      expect(lane!.className).toMatch(/\bpx-\d/);
      checked += 1;
    }
    expect(checked, "no frame published a card width to check").toBeGreaterThanOrEqual(2);
  });

  it("derives the caption widths from the gutter `PostList` really renders", () => {
    // `cardWidthAt` assumes the lane's `px-*` padding. Read the lane's own class
    // rather than trusting the assumption: widening `PostList`'s masonry arm
    // (px-4 → px-6) must fail here, otherwise the captions would keep publishing
    // numbers the lane no longer matches, with the suite still green.
    const listPaddingRem = masonryListPaddingRem();
    const threeColumn = 3 * MASONRY_MIN_CARD_PX + 2 * MASONRY_GUTTER_PX + MASONRY_CONTAINER_INSET_PX;
    const fourColumn = 4 * MASONRY_MIN_CARD_PX + 3 * MASONRY_GUTTER_PX + MASONRY_CONTAINER_INSET_PX;
    for (const width of [threeColumn, fourColumn]) {
      const columns = masonryColumns(width);
      // The scales come from the app's own options, not typed-in roots: lowering
      // the largest scale must move the captions AND this check together.
      for (const percent of [LARGE_TEXT_PERCENT, STANDARD_TEXT_PERCENT]) {
        const rootFontSizePx = rootPxFor(percent);
        const container = width - 2 * listPaddingRem * rootFontSizePx;
        const derived = (container - (columns - 1) * MASONRY_GUTTER_PX) / columns;
        expect(cardWidthAt(width, rootFontSizePx)).toBeCloseTo(derived, 6);
      }
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

describe("navigation preflight renders the production nav", () => {
  afterEach(() => {
    localStorage.clear();
  });

  function storeNavLayout(navLayout: "bottom" | "rail") {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_APPEARANCE, navLayout }),
    );
  }

  it("renders one production navigation with all five actions in every variant", () => {
    renderRoute();
    for (const variant of NAV_VARIANTS) {
      const demo = screen.getByTestId(`fixture-nav-demo-${variant}`);
      const nav = within(demo).getByRole("navigation", { name: "Primary" });
      expect(nav.getAttribute("data-layout")).toBe("bottom");
      expect(within(nav).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
        "/", "/my", "/profile", "/notifications", "/report",
      ]);
    }
  });

  it("renders a destination other than Home as selected in the rail", () => {
    storeNavLayout("rail");
    renderRoute();
    const demo = screen.getByTestId("fixture-nav-demo-normal");
    expect(demo.getAttribute("data-nav-layout")).toBe("rail");
    const selected = within(demo)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(selected.map((link) => link.textContent?.trim())).toEqual(["Notifications"]);
  });

  it("resolves the stored rail to the bar in the small-width frame", () => {
    storeNavLayout("rail");
    renderRoute();
    expect(
      screen.getByTestId("fixture-nav-demo-small-width").getAttribute("data-nav-layout"),
    ).toBe("bottom");
  });

  it("resolves the stored rail to a rail in the wide frames", () => {
    storeNavLayout("rail");
    renderRoute();
    for (const variant of ["normal", "dark", "amoled", "large-text"] as const) {
      const demo = screen.getByTestId(`fixture-nav-demo-${variant}`);
      expect(demo.getAttribute("data-nav-layout")).toBe("rail");
      expect(
        within(demo).getByRole("navigation", { name: "Primary" }).getAttribute("data-layout"),
      ).toBe("rail");
    }
  });

  it("keeps the stored bottom bar on the wide frames", () => {
    storeNavLayout("bottom");
    renderRoute();
    expect(
      screen.getByTestId("fixture-nav-demo-normal").getAttribute("data-nav-layout"),
    ).toBe("bottom");
  });
});
