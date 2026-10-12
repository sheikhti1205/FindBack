// @vitest-environment jsdom
// W7B-HOME (FBX-019): carousel viewport clips to the token radius so the
// near-full-width media reads as one rounded photo, not a boxed card.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FeedMediaCarousel, type FeedCarouselImage } from "./FeedMediaCarousel";

function images(n: number): FeedCarouselImage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i + 1}`,
    fileUrl: `https://cdn.example/a${i + 1}.jpg`,
    alt: `Photo ${i + 1}`,
  }));
}

afterEach(cleanup);

describe("W7B-HOME FeedMediaCarousel viewport", () => {
  it("carries the media-led hook class with a stable 4:3 aspect", () => {
    render(<FeedMediaCarousel images={images(2)} onOpenImage={() => {}} />);
    const viewport = screen.getByTestId("feed-media-viewport");
    expect(viewport.className).toContain("fb-home-media-viewport");
    expect(viewport.style.aspectRatio.replace(/\s/g, "")).toBe("4/3");
  });

  it("keeps the scroll-snap track + dots contracts", () => {
    render(<FeedMediaCarousel images={images(2)} onOpenImage={() => {}} />);
    expect(screen.getByTestId("feed-media-track").className).toMatch(/snap-x/);
    expect(screen.getAllByTestId("carousel-dot")).toHaveLength(2);
  });
});
