// @vitest-environment jsdom
/**
 * Settings → Feed layout (CF-010, packet `09` §6, §23).
 *
 * The screen is a thin owner over two things that each have their own tests:
 * `useFeedLayoutPreference` (where the choice lives) and `resolveFeedLayout`
 * (what it means on a width). What is asserted here is the wiring a reader can
 * actually see: the four packet-named options, apply-on-pick persistence, and
 * an honest statement of what this screen resolved to — `Auto` must never leave
 * the reader guessing which layout they are looking at.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { feedLayoutSummary, FeedLayoutSettings } from "./FeedLayoutSettings";
import { FEED_LAYOUT_STORAGE_KEY } from "../services/feedLayoutPreference";

const ORIGINAL_WIDTH = window.innerWidth;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

function renderScreen() {
  return render(
    <MemoryRouter>
      <FeedLayoutSettings />
    </MemoryRouter>,
  );
}

function radios(): HTMLInputElement[] {
  return screen.getAllByRole("radio") as HTMLInputElement[];
}

function radio(name: string): HTMLInputElement {
  return screen.getByRole("radio", { name }) as HTMLInputElement;
}

beforeEach(() => {
  localStorage.clear();
  setViewportWidth(1024);
});

afterEach(() => {
  cleanup();
  setViewportWidth(ORIGINAL_WIDTH);
});

describe("feedLayoutSummary", () => {
  it("names the layout the reader will see, keeping Auto visible when Auto chose it", () => {
    expect(feedLayoutSummary("auto", "masonry")).toBe("Auto · Masonry");
    expect(feedLayoutSummary("masonry", "masonry")).toBe("Masonry");
    expect(feedLayoutSummary("feed", "feed")).toBe("Feed");
    expect(feedLayoutSummary("compact", "compact")).toBe("Compact");
  });
});

describe("Feed layout settings screen", () => {
  it("offers exactly the four layouts the packet names", () => {
    renderScreen();
    expect(radios().map((el) => el.value)).toEqual(["auto", "feed", "compact", "masonry"]);
    expect(radio("Auto").checked).toBe(true);
    expect(radio("Feed").checked).toBe(false);
  });

  it("applies and persists the pick the moment it is made, with no Save step", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("radio", { name: "Compact" }));
    expect(radio("Compact").checked).toBe(true);
    expect(JSON.parse(localStorage.getItem(FEED_LAYOUT_STORAGE_KEY) ?? "null")).toBe("compact");
    // No save button exists to forget to press.
    expect(screen.queryByRole("button", { name: /save|apply/i })).toBeNull();
  });

  it("opens on the stored pick rather than on the default", () => {
    localStorage.setItem(FEED_LAYOUT_STORAGE_KEY, JSON.stringify("masonry"));
    renderScreen();
    expect(radio("Masonry").checked).toBe(true);
  });

  it("treats an unknown stored value as Auto instead of guessing a layout", () => {
    localStorage.setItem(FEED_LAYOUT_STORAGE_KEY, JSON.stringify("carousel"));
    renderScreen();
    expect(radio("Auto").checked).toBe(true);
  });

  it("states what this screen resolves to, in the reader's terms", () => {
    renderScreen();
    expect(screen.getByTestId("feed-layout-resolved").textContent).toBe(
      "This screen fits a photo grid.",
    );
  });

  it("re-states the resolution when the viewport cannot fit a grid", () => {
    setViewportWidth(390);
    renderScreen();
    expect(screen.getByTestId("feed-layout-resolved").textContent).toBe("This screen shows one column.");
  });

  it("honours an explicit pick even on a narrow screen, rather than silently overriding it", () => {
    setViewportWidth(390);
    renderScreen();
    fireEvent.click(screen.getByRole("radio", { name: "Masonry" }));
    expect(radio("Masonry").checked).toBe(true);
    expect(screen.getByTestId("feed-layout-resolved").textContent).toBe(
      "This screen fits a photo grid.",
    );
  });
});
