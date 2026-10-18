// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { BackButton } from "./BackButton";

/**
 * Device-found defect: the back affordance was labelled with a *destination*
 * ("Back to profile") while the control is history-aware and therefore usually
 * navigates to whatever the previous screen was. On the emulator, tapping it on
 * "My reports" landed on the feed.
 *
 * A label that promises one destination and delivers another misleads anyone
 * who relies on it — screen-reader users most of all, since the arrow icon is
 * `aria-hidden` and the label is the only thing announced.
 */

function renderBack() {
  return render(
    <MemoryRouter initialEntries={["/", "/myposts"]} initialIndex={1}>
      <Routes>
        <Route
          path="/myposts"
          element={<BackButton fallbackTo="/profile" label="Back to profile" />}
        />
        <Route path="/" element={<p>previous screen</p>} />
        <Route path="/profile" element={<p>profile screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "");
});

describe("BackButton accessible label", () => {
  it("names the fallback destination only when that is where it actually goes", () => {
    window.history.replaceState({ idx: 0 }, "");
    renderBack();
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Back to profile");
  });

  it("does not promise a destination when it will walk the history stack", () => {
    window.history.replaceState({ idx: 1 }, "");
    renderBack();
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Back");
  });
});

describe("BackButton behaviour", () => {
  it("walks history when the app stack has an entry, whatever the fallback is", () => {
    window.history.replaceState({ idx: 1 }, "");
    renderBack();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("previous screen")).not.toBeNull();
    expect(screen.queryByText("profile screen")).toBeNull();
  });

  it("uses the fallback destination when the stack is empty", () => {
    window.history.replaceState({ idx: 0 }, "");
    renderBack();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("profile screen")).not.toBeNull();
  });
});
