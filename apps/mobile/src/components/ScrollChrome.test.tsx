// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { CHROME_GAP_CANCEL, ScrollChrome } from "./ScrollChrome";

afterEach(cleanup);

function shell(hidden: boolean) {
  return (
    <div className="flex flex-col gap-4">
      <ScrollChrome hidden={hidden} testId="fixture-chrome">
        <div className="h-10" />
      </ScrollChrome>
      <p>feed</p>
    </div>
  );
}

describe("ScrollChrome (CF-010 §3)", () => {
  it("cancels the parent's gap on the same motion as the height", async () => {
    // The gap used to be written through `style`, so it landed on the first
    // frame while the height was still interpolating: the sibling below snapped
    // up by 16px before the collapse had visibly started. Animating it keeps
    // the two together.
    const { rerender } = render(shell(false));
    const chrome = screen.getByTestId("fixture-chrome");

    rerender(shell(true));
    expect(chrome.getAttribute("data-collapsed")).toBe("true");
    // THE assertion this test exists for: the gap must not land before the
    // motion does. Writing it through `style` puts it on the first frame while
    // the height is still interpolating, and the sibling below snaps up by the
    // gap before the collapse has visibly started (measured 16px).
    expect(chrome.style.marginBottom).not.toBe(CHROME_GAP_CANCEL);
    // Framer writes the authored value through, so the string is the contract.
    // It must be in `rem`, not px: the parent's `gap-4` is 1rem, which scales
    // with the reader's text size, and a fixed -16px would leave a hole at
    // larger text scales. Rendered geometry is measured in the fixture review.
    await waitFor(() => expect(chrome.style.marginBottom).toBe(CHROME_GAP_CANCEL));
    expect(chrome.style.marginBottom).toBe("-1rem");
  });

  it("leaves no gap cancellation behind when the chrome is visible", async () => {
    const { rerender } = render(shell(true));
    const chrome = screen.getByTestId("fixture-chrome");
    await waitFor(() => expect(chrome.style.marginBottom).toBe("-1rem"));

    rerender(shell(false));
    // Symmetrical: the gap comes back with the motion, not ahead of it.
    expect(chrome.style.marginBottom).not.toBe("0rem");
    await waitFor(() => expect(chrome.style.marginBottom).toBe("0rem"));
  });

  it("clips only while collapsed, and stays inert while collapsed", async () => {
    const { rerender } = render(shell(false));
    const chrome = screen.getByTestId("fixture-chrome");
    // Open chrome must never clip a focus ring or a dropdown.
    expect(chrome.style.overflow).toBe("visible");
    expect(chrome.getAttribute("inert")).toBeNull();

    rerender(shell(true));
    await waitFor(() => expect(chrome.style.overflow).toBe("hidden"));
    // A real attribute, never aria-hidden: the controls keep their state.
    expect(chrome.getAttribute("inert")).not.toBeNull();
  });
});
