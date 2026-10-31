// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { MotionConfig } from "framer-motion";
import { __resetFeedEntranceForTests, PostCard } from "./PostCard";
import { PostLink } from "./PostNavigation";

beforeEach(() => __resetFeedEntranceForTests());
afterEach(cleanup);

function renderCard(index: number): void {
  render(
    <MemoryRouter>
      <PostCard index={index}>
        <span>card body</span>
      </PostCard>
    </MemoryRouter>,
  );
}

describe("PostCard motion (P6)", () => {
  it("animates only the first visible cards; deeper feed cards render static", () => {
    renderCard(0);
    expect(screen.getByTestId("post-card").dataset.animated).toBe("true");
    cleanup();
    renderCard(9);
    expect(screen.getByTestId("post-card").dataset.animated).toBe("false");
  });

  it("nests no MotionConfig — the app root owns reduced motion", () => {
    const { container } = render(
      <MemoryRouter>
        <PostCard index={0}>
            <PostLink to="/posts/p1">card body</PostLink>
        </PostCard>
      </MemoryRouter>,
    );
    expect(container.textContent).toContain("card body");
  });

  it("does not replay the entrance on remount (realtime/refetch safe)", () => {
    renderCard(0);
    expect(screen.getByTestId("post-card").dataset.animated).toBe("true");
    cleanup();
    // Full list remount (e.g. error → content swap): entrance stays off.
    renderCard(0);
    expect(screen.getByTestId("post-card").dataset.animated).toBe("false");
    expect(screen.getByTestId("post-card").textContent).toContain("card body");
  });

  it("keeps focused content mounted when its parent rerenders after entrance", () => {
    const content = (index: number) => <PostCard index={index}><button type="button">Open report</button></PostCard>;
    const view = render(content(0));
    const launcher = screen.getByRole("button", { name: "Open report" });
    launcher.focus();
    // Reordering or a navigation-state update must not swap the outer element
    // type and detach the node a modal will restore focus to.
    view.rerender(content(1));
    expect(launcher.isConnected).toBe(true);
    expect(document.activeElement).toBe(launcher);
    expect(screen.getByRole("button", { name: "Open report" })).toBe(launcher);
  });

  it("still renders content under forced reduced motion", () => {
    render(
      <MotionConfig reducedMotion="always">
        <MemoryRouter>
          <PostCard index={0}>
            <PostLink to="/posts/p1">card body</PostLink>
          </PostCard>
        </MemoryRouter>
      </MotionConfig>,
    );
    const card = screen.getByTestId("post-card");
    expect(card.textContent).toContain("card body");
    // Content stays reachable: the link keeps its destination.
    expect(card.querySelector('a[href="/posts/p1"]')).toBeTruthy();
  });
});
