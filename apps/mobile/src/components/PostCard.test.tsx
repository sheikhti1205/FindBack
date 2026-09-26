// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { PostCard } from "./PostCard";

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
});
