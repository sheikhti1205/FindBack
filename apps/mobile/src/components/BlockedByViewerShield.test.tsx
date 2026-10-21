// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BlockedByViewerShield } from "./BlockedByViewerShield";

afterEach(cleanup);

function shield(rowId = "p1", blocked = true) {
  return (
    <BlockedByViewerShield rowId={rowId} blocked={blocked}>
      <a href="/posts/p1">Report title</a>
      <button type="button">Like</button>
    </BlockedByViewerShield>
  );
}

describe("BlockedByViewerShield", () => {
  it("renders no wrapper at all when the bit is absent or false", () => {
    const { container, rerender } = render(shield("p1", false));
    expect(screen.queryByTestId("blocked-shield")).toBeNull();
    expect(container.querySelector('[data-testid="blocked-shield-content"]')).toBeNull();
    // The children are the direct content: the pre-R10 rendering is untouched.
    expect(screen.getByRole("link", { name: "Report title" })).toBeTruthy();

    rerender(
      <BlockedByViewerShield rowId="p1">
        <a href="/posts/p1">Report title</a>
      </BlockedByViewerShield>,
    );
    expect(screen.queryByTestId("blocked-shield")).toBeNull();
  });

  it("obscures the content, hides it from assistive tech and offers one real button", () => {
    render(shield());

    const content = screen.getByTestId("blocked-shield-content");
    const warning = screen.getByTestId("blocked-shield-warning");
    const reveal = screen.getByRole("button", { name: "Show content" });

    expect(content.getAttribute("inert")).not.toBeNull();
    expect(content.getAttribute("aria-hidden")).toBe("true");
    expect(content.className).toContain("blur-");
    expect(content.className).toContain("pointer-events-none");
    expect(warning.textContent).toContain("Content hidden");
    // Direction-free copy: never names who blocked whom.
    expect(warning.textContent).not.toMatch(/\byou blocked\b/i);
    expect(warning.textContent).not.toMatch(/\bblocked you\b/i);
    expect(reveal.tagName).toBe("BUTTON");
    expect(reveal.getAttribute("type")).toBe("button");
    expect(reveal.className).toContain("min-h-[44px]");
  });

  it("keeps the reveal control a sibling of the inert subtree, never inside an anchor", () => {
    const { container } = render(shield());

    const reveal = screen.getByRole("button", { name: "Show content" });
    const content = screen.getByTestId("blocked-shield-content");

    expect(content.contains(reveal)).toBe(false);
    expect(reveal.closest("a")).toBeNull();
    expect(reveal.closest("button")).toBe(reveal);
    // Exactly one reveal control, and the locked subtree keeps its own links
    // (inert) rather than losing them — structural, not a hiding trick.
    expect(container.querySelectorAll("button").length).toBe(2); // reveal + the child Like
  });

  it("reveals on activation and moves focus onto the revealed content", () => {
    render(shield());

    const reveal = screen.getByRole("button", { name: "Show content" });
    fireEvent.click(reveal);

    const content = screen.getByTestId("blocked-shield-content");
    expect(screen.queryByTestId("blocked-shield-warning")).toBeNull();
    expect(content.getAttribute("inert")).toBeNull();
    expect(content.getAttribute("aria-hidden")).toBeNull();
    expect(content.className).not.toContain("blur-");
    // Focus continuity: the button is gone, so focus must not fall to <body>.
    expect(document.activeElement).toBe(content);
    // The previously inert controls are operable again in the DOM.
    expect(screen.getByRole("button", { name: "Like" })).toBeTruthy();
  });

  it("is per row: revealing one shield never reveals another", () => {
    render(
      <>
        {shield("a", true)}
        {shield("b", true)}
      </>,
    );

    const reveals = screen.getAllByRole("button", { name: "Show content" });
    expect(reveals).toHaveLength(2);
    fireEvent.click(reveals[0]!);

    const contents = screen.getAllByTestId("blocked-shield-content");
    expect(contents[0]!.getAttribute("inert")).toBeNull();
    expect(contents[1]!.getAttribute("inert")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Show content" })).toHaveLength(1);
  });

  it("starts concealed again when the row identity is replaced", () => {
    const { rerender } = render(shield("p1", true));
    fireEvent.click(screen.getByRole("button", { name: "Show content" }));
    expect(screen.queryByTestId("blocked-shield-warning")).toBeNull();

    // Same component position, different row: state must not be inherited.
    rerender(shield("p2", true));
    expect(screen.getByTestId("blocked-shield-warning")).toBeTruthy();
    expect(screen.getByTestId("blocked-shield-content").getAttribute("inert")).not.toBeNull();
  });

  it("starts concealed again after a remount", () => {
    const first = render(shield());
    fireEvent.click(screen.getByRole("button", { name: "Show content" }));
    first.unmount();

    render(shield());
    expect(screen.getByTestId("blocked-shield-warning")).toBeTruthy();
    expect(screen.getByTestId("blocked-shield-content").getAttribute("inert")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row mode (CF-060 R10 defect fix). The profile row measured 288x77 while the
// overlay warning card measured 288x151: an absolute inset-0 overlay spilled
// ~74px over the NEXT report row. Row mode puts both in one grid cell so the
// box is max(content, warning) and the warning can never leave its own row.
// ---------------------------------------------------------------------------
describe("BlockedByViewerShield row mode", () => {
  function rowShield(rowId = "p1") {
    return (
      <BlockedByViewerShield rowId={rowId} blocked mode="row">
        <a href="/posts/p1">Report title</a>
      </BlockedByViewerShield>
    );
  }

  it("does not position the warning outside its own box (no absolute overlay)", () => {
    render(rowShield());

    const shieldEl = screen.getByTestId("blocked-shield");
    const warning = screen.getByTestId("blocked-shield-warning");

    expect(shieldEl.className).toContain("grid");
    expect(shieldEl.getAttribute("data-mode")).toBe("row");
    // Both children share one grid cell: the cell is max(content, warning), so
    // the warning's height can never paint past the wrapper.
    expect(warning.className).toContain("col-start-1");
    expect(warning.className).toContain("row-start-1");
    expect(warning.className).not.toContain("absolute");
    expect(screen.getByTestId("blocked-shield-content").className).toContain("col-start-1");
  });

  it("fully obscures the row content while locked (invisible + inert), not a readable blur", () => {
    render(rowShield());

    const content = screen.getByTestId("blocked-shield-content");
    expect(content.className).toContain("invisible");
    expect(content.className).not.toContain("blur-");
    expect(content.getAttribute("inert")).not.toBeNull();
    expect(content.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the warning mounted but invisible after reveal, so the box height cannot change", () => {
    render(rowShield());

    const before = screen.getByTestId("blocked-shield-warning").className;
    fireEvent.click(screen.getByRole("button", { name: "Show content" }));

    const warning = screen.getByTestId("blocked-shield-warning");
    // Still in the same grid cell → same contribution to the cell height.
    expect(warning.className).toContain("col-start-1");
    expect(warning.className).toContain("invisible");
    expect(warning.getAttribute("aria-hidden")).toBe("true");
    expect(warning.getAttribute("inert")).not.toBeNull();
    // Locked/unlocked warning chrome differs only by `invisible`.
    expect(before.trim()).toBe(warning.className.replace("invisible", "").trim());

    // Content is visible and focused again.
    const content = screen.getByTestId("blocked-shield-content");
    expect(content.className).not.toContain("invisible");
    expect(content.className).not.toContain("pointer-events-none");
    expect(content.getAttribute("inert")).toBeNull();
    expect(document.activeElement).toBe(content);
  });

  it("keeps the reveal control in its own row and outside the hidden anchor", () => {
    render(rowShield());

    const reveal = screen.getByRole("button", { name: "Show content" });
    const content = screen.getByTestId("blocked-shield-content");

    expect(content.contains(reveal)).toBe(false);
    expect(reveal.closest("a")).toBeNull();
    // The control is in the same grid cell as the anchor it belongs to, not a
    // stray sibling row of some other report.
    expect(reveal.closest('[data-testid="blocked-shield-warning"]')).toBeTruthy();
  });

  it("starts concealed on a row-id replacement, exactly like overlay mode", () => {
    const { rerender } = render(rowShield("a"));
    fireEvent.click(screen.getByRole("button", { name: "Show content" }));
    expect(screen.getByTestId("blocked-shield-warning").className).toContain("invisible");

    rerender(rowShield("b"));
    expect(screen.getByTestId("blocked-shield-warning").className).not.toContain("invisible");
    expect(screen.getByTestId("blocked-shield-content").getAttribute("inert")).not.toBeNull();
  });
});
