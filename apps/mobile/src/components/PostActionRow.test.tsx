// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostActionRow } from "./PostActionRow";
import { widthBand } from "./responsive";

afterEach(cleanup);

/** The house action token the row's controls sit on (index.css). */
const indexCss = readFileSync("src/index.css", "utf8");
/** The row's own scoped stylesheet. */
const rowCss = readFileSync("src/components/PostActionRow.css", "utf8");
/** The stylesheet without its comments — the contract is about declarations. */
const rowCssRules = rowCss.replace(/\/\*[\s\S]*?\*\//g, "");

function LikeSlot({ pressed = false }: { pressed?: boolean }) {
  return (
    <button
      type="button"
      data-testid="slotted-like"
      aria-pressed={pressed}
      aria-label={pressed ? "Liked, 24 likes" : "Like this report, 24 likes"}
      className="fb-report-action"
    >
      <span aria-hidden className="tabular-nums">24</span>
    </button>
  );
}

function ShareSlot() {
  return (
    <button type="button" aria-label="Share report" className="fb-report-action">
      <span>Share</span>
    </button>
  );
}

function SaveSlot() {
  return (
    <button type="button" aria-label="Save report" className="fb-report-action">
      <span>Save</span>
    </button>
  );
}

function renderRow(props: Partial<ComponentProps<typeof PostActionRow>> = {}) {
  return render(
    <MemoryRouter>
      <PostActionRow
        commentCount={3}
        slots={{ like: <LikeSlot />, share: <ShareSlot /> }}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("PostActionRow (compact flat action row)", () => {
  it("renders one row that owns the group semantics", () => {
    renderRow();
    const row = screen.getByTestId("post-action-row");
    expect(row.getAttribute("role")).toBe("group");
    expect(row.getAttribute("aria-label")).toBe("Report actions");
    // A single row: no grid, no wrapping — the controls stay on one line.
    expect(row.className).toMatch(/flex/);
    expect(row.className).toMatch(/flex-nowrap/);
    expect(row.className).not.toMatch(/grid/);
    expect(row.className).toMatch(/min-w-0/);
  });

  it("slots the caller's own controls instead of re-owning their state", () => {
    renderRow({ slots: { like: <LikeSlot />, share: <ShareSlot />, save: <SaveSlot /> } });
    expect(screen.getByTestId("slotted-like")).toBeTruthy();
    expect(screen.getByRole("button", { name: /share report/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /save report/i })).toBeTruthy();
  });

  it("keeps the slotted controls' pressed state and keyboard behaviour", () => {
    const onClick = vi.fn();
    render(
      <MemoryRouter>
        <PostActionRow
          commentCount={3}
          slots={{
            like: (
              <button type="button" aria-pressed="false" aria-label="Like" className="fb-report-action" onClick={onClick}>
                <span aria-hidden className="tabular-nums">24</span>
              </button>
            ),
          }}
        />
      </MemoryRouter>,
    );
    const like = screen.getByRole("button", { name: /like/i });
    expect(like.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(like);
    expect(onClick).toHaveBeenCalledTimes(1);
    // The row never rewrites the slotted control's own pressed state.
    expect(like.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the comment count next to the icon and announces it", () => {
    renderRow({ commentCount: 7 });
    const comments = screen.getByRole("button", { name: "Comments, 7" });
    expect(comments.textContent).toContain("7");
    // The icon carries no name of its own.
    expect(comments.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders the comment affordance as a link when a destination is given", () => {
    renderRow({ commentsHref: "/posts/p1#detail-comments" });
    const comments = screen.getByRole("link", { name: "Comments, 3" });
    expect(comments.getAttribute("href")).toBe("/posts/p1#detail-comments");
  });

  it("calls onComments when no destination is given", () => {
    const onComments = vi.fn();
    renderRow({ slots: { like: <LikeSlot />, onComments } });
    fireEvent.click(screen.getByRole("button", { name: "Comments, 3" }));
    expect(onComments).toHaveBeenCalledTimes(1);
  });

  it("disables the comment affordance when nothing can handle it", () => {
    renderRow();
    expect((screen.getByRole("button", { name: "Comments, 3" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("adds no visible text label of its own for an action", () => {
    renderRow({ slots: { like: <LikeSlot />, share: <ShareSlot />, save: <SaveSlot /> } });
    // The comment affordance renders an icon and its count — never a caption.
    const comments = screen.getByRole("button", { name: "Comments, 3" });
    expect(comments.textContent).toBe("3");
    expect(comments.textContent).not.toMatch(/comment/i);
    // A slotted control's own caption stays in the accessibility tree (it is
    // never dropped) but is taken out of the visual flow by the row's scoped
    // rule — see the CSS contract below.
    expect(screen.getByRole("button", { name: /share report/i }).textContent).toBe("Share");
  });

  it("keeps a >=44px hit area on every control", () => {
    renderRow({ slots: { like: <LikeSlot />, share: <ShareSlot />, save: <SaveSlot /> } });
    // The house token already guarantees the width; the row's own rule keeps
    // the height at the 44px minimum instead of the token's 48px card.
    expect(indexCss).toMatch(/\.fb-report-action\s*\{[^}]*min-width:\s*44px/);
    expect(rowCss).toMatch(/\.fb-post-action-row \.fb-report-action\s*\{[^}]*min-height:\s*44px/);
  });

  it("fits a 320dp canvas without wrapping or clipping", () => {
    renderRow({ slots: { like: <LikeSlot />, share: <ShareSlot />, save: <SaveSlot /> } });
    // The repo's own width vocabulary: 320dp is the narrowest canvas the app
    // supports and it stays in the compact band.
    expect(widthBand(320)).toBe("compact");
    // Four controls at the 44px minimum plus the row's 2px gaps and the text
    // block's 16px gutters must fit the narrowest canvas the app supports.
    const rowWidth = 4 * 44 + 3 * 2 + 2 * 16;
    expect(rowWidth).toBeLessThanOrEqual(320);
    const row = screen.getByTestId("post-action-row");
    expect(row.className).toMatch(/flex-nowrap/);
    expect(row.className).toMatch(/min-w-0/);
  });

  it("flattens the reused button-card chrome in one scoped rule", () => {
    // The house token paints a bordered, filled button card. Inside the row
    // those are neutralised by one higher-specificity rule — never by an
    // `!important` utility pile (which the grid used to carry).
    const flat = rowCssRules.match(/\.fb-post-action-row \.fb-report-action\s*\{[^}]*\}/)?.[0] ?? "";
    expect(flat).toMatch(/border:\s*0/);
    expect(flat).toMatch(/background:\s*transparent/);
    expect(flat).toMatch(/flex-direction:\s*row/);
    expect(flat).not.toMatch(/!important/);
    expect(rowCssRules).not.toMatch(/!important/);
  });

  it("keeps a slotted caption available to assistive tech but out of the visual flow", () => {
    const hidden = rowCss.match(/\.fb-post-action-row \.fb-report-action > span:not\(\.tabular-nums\)\s*\{[^}]*\}/)?.[0] ?? "";
    expect(hidden).toMatch(/clip-path:\s*inset\(50%\)/);
    // Counts are never hidden.
    expect(hidden).toMatch(/not\(\.tabular-nums\)/);
  });
});
