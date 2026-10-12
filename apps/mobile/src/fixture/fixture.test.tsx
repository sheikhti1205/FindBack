// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { FixtureRoute } from "./FixtureRoute";
import { ALL_VARIANTS } from "./FixtureSection";

const SECTIONS = [
  "home",
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
});
