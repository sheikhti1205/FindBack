// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { MotionConfig } from "framer-motion";
import { __resetFeedEntranceForTests, PostCard } from "./PostCard";

beforeEach(() => __resetFeedEntranceForTests());
afterEach(cleanup);

function renderCard(index: number): void {
  render(
    <MemoryRouter>
      <PostCard to="/posts/p1" index={index}>
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
        <PostCard to="/posts/p1" index={0}>
          <span>card body</span>
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

  it("still renders content under forced reduced motion", () => {
    render(
      <MotionConfig reducedMotion="always">
        <MemoryRouter>
          <PostCard to="/posts/p1" index={0}>
            <span>card body</span>
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
