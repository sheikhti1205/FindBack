// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  CommentSkeleton,
  DetailSkeleton,
  EmptyView,
  EnterReveal,
  ErrorView,
  FeedSkeleton,
  InboxSkeleton,
  Skeleton,
  StateSwap,
} from "./uiPrimitives";

describe("uiPrimitives", () => {
  afterEach(() => cleanup());

  it("Skeleton renders a stable fixed-size block with an accessible label", () => {
    const { container } = render(<Skeleton label="Loading post" width={120} height={16} />);
    expect(screen.getByRole("status", { name: "Loading post" })).toBeTruthy();
    const block = container.querySelector("[data-testid='skeleton-block']") as HTMLElement;
    expect(block.style.width).toBe("120px");
    expect(block.style.height).toBe("16px");
  });

  it("Skeleton honors reduced-motion (no shimmer animation class escape)", () => {
    const { container } = render(<Skeleton label="Loading" />);
    const block = container.querySelector("[data-testid='skeleton-block']") as HTMLElement;
    expect(block.className).toContain("motion-reduce:animate-none");
  });

  it("FeedSkeleton renders stable home-feed cards without layout jump", () => {
    render(<FeedSkeleton density="home-feed" count={2} label="Loading posts" />);
    expect(screen.getByRole("status", { name: "Loading posts" })).toBeTruthy();
    expect(document.querySelectorAll("[data-testid='feed-skeleton-card']").length).toBe(2);
    // Fixed media height prevents reflow when content resolves.
    const media = document.querySelector(
      "[data-testid='feed-skeleton-card'] [data-testid='feed-skeleton-media']",
    ) as HTMLElement;
    expect(media).toBeTruthy();
  });

  it("FeedSkeleton reserves the masonry grid it is about to replace (CF-010)", () => {
    render(<FeedSkeleton density="masonry" count={6} columns={3} label="Loading posts" />);
    const grid = screen.getByTestId("feed-skeleton-masonry");
    expect(grid.getAttribute("data-columns")).toBe("3");
    // Two skeleton cards per column, so the first paint occupies the same grid
    // the real cards land in instead of moving with the page.
    expect(grid.querySelectorAll("[data-testid='feed-skeleton-card']").length).toBe(6);
    // Ragged ratios, never equal rows: the unequal heights are the layout.
    const ratios = new Set(
      Array.from(grid.querySelectorAll<HTMLElement>("[data-testid='feed-skeleton-media']")).map(
        (media) => media.style.aspectRatio,
      ),
    );
    expect(ratios.size).toBeGreaterThan(1);
    // Every reserved box has a shape, so nothing collapses before the photos land.
    expect([...ratios].every((ratio) => ratio.length > 0)).toBe(true);
  });

  it("FeedSkeleton never picks a column count of zero", () => {
    render(<FeedSkeleton density="masonry" count={3} columns={0} label="Loading posts" />);
    expect(screen.getByTestId("feed-skeleton-masonry").getAttribute("data-columns")).toBe("1");
  });

  it("InboxSkeleton renders fixed avatar+line rows", () => {
    render(<InboxSkeleton count={3} />);
    expect(document.querySelectorAll("[data-testid='inbox-skeleton-row']").length).toBe(3);
  });

  it("DetailSkeleton renders hero + body without spinner text", () => {
    render(<DetailSkeleton />);
    expect(screen.getByRole("status", { name: "Loading report" })).toBeTruthy();
    expect(screen.queryByText(/Loading post/)).toBeNull();
  });

  it("CommentSkeleton renders fixed rows", () => {
    render(<CommentSkeleton count={2} />);
    expect(document.querySelectorAll("[data-testid='comment-skeleton-row']").length).toBe(2);
  });

  it("StateSwap makes the entering keyed state available immediately", () => {
    const { rerender } = render(
      <StateSwap stateKey="a">
        <p>first</p>
      </StateSwap>,
    );
    expect(screen.getByText("first")).toBeTruthy();
    rerender(
      <StateSwap stateKey="b">
        <p>second</p>
      </StateSwap>,
    );
    // The entering state is available immediately, overlapping the outgoing
    // one. Browser frame/scroll geometry is covered by scripts/ui-review.
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("EnterReveal renders content with first-reveal stagger", () => {
    render(
      <EnterReveal index={1}>
        <p>revealed</p>
      </EnterReveal>,
    );
    expect(screen.getByText("revealed")).toBeTruthy();
  });

  it("EmptyView renders title, subtitle, and action", () => {
    render(
      <EmptyView title="No matches" subtitle="Try different filters." action={<button type="button">Retry</button>} />,
    );
    expect(screen.getByText("No matches")).toBeTruthy();
    expect(screen.getByText("Try different filters.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("ErrorView renders message with retry affordance", () => {
    render(<ErrorView message="Could not load" onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Could not load")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
