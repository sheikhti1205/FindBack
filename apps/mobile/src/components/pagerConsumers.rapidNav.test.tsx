// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedMediaCarousel } from "./FeedMediaCarousel";
import { DetailHeroGallery } from "./detail/DetailHeroGallery";

/**
 * The jump guard lives in the shared pager, so its other two consumers must
 * behave the same way: a dot/tab jump keeps the chosen page while the smooth
 * animation runs, and a real gesture on the track takes over immediately.
 * These are the consumer halves of the CF-020 rapid dot → action fix.
 */

const FEED = Array.from({ length: 3 }, (_, i) => ({
  id: `a${i + 1}`,
  fileUrl: `https://cdn.example/a${i + 1}.jpg`,
  alt: `Photo ${i + 1}`,
}));
const HERO = Array.from({ length: 3 }, (_, i) => ({
  fileUrl: `https://cdn.example/h${i + 1}.jpg`,
  alt: `Photo ${i + 1}`,
}));

afterEach(cleanup);

function track(testId: string, width = 300): HTMLElement {
  const el = screen.getByTestId(testId);
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
  return el;
}

function scrollFrame(el: HTMLElement, left: number): void {
  el.scrollLeft = left;
  fireEvent.scroll(el);
}

function feedActive(): string | null {
  return (
    screen.getAllByTestId("carousel-dot").find((d) => d.getAttribute("aria-current") === "true")
      ?.getAttribute("data-index") ?? null
  );
}

function heroActive(): string | null {
  const selected = screen
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true");
  return selected?.getAttribute("aria-label") ?? null;
}

describe("FeedMediaCarousel shares the jump guard", () => {
  it("keeps the chosen dot while the jump animates, then follows the scroll", () => {
    render(<FeedMediaCarousel images={FEED} onOpenImage={() => {}} />);
    const el = track("feed-media-track");

    fireEvent.click(screen.getAllByTestId("carousel-dot")[1]!);
    scrollFrame(el, 2);
    scrollFrame(el, 88);
    expect(feedActive()).toBe("1");

    scrollFrame(el, 300); // arrival
    expect(feedActive()).toBe("1");
    scrollFrame(el, 0);
    expect(feedActive()).toBe("0");
  });

  it("lets a pointer gesture take over an in-flight jump", () => {
    render(<FeedMediaCarousel images={FEED} onOpenImage={() => {}} />);
    const el = track("feed-media-track");
    fireEvent.click(screen.getAllByTestId("carousel-dot")[2]!);
    scrollFrame(el, 2);
    expect(feedActive()).toBe("2");

    fireEvent.pointerDown(el, { clientX: 250, clientY: 40 });
    scrollFrame(el, 0);
    expect(feedActive()).toBe("0");
  });
});

describe("DetailHeroGallery shares the jump guard", () => {
  it("keeps the chosen tab while the jump animates, then follows the scroll", () => {
    render(
      <DetailHeroGallery postId="p1" title="Wallet" images={HERO} onOpenLightbox={vi.fn()} />,
    );
    const el = track("detail-hero-track", 320);

    fireEvent.click(screen.getByRole("tab", { name: "Show photo 2" }));
    scrollFrame(el, 2);
    scrollFrame(el, 120);
    expect(heroActive()).toBe("Show photo 2");

    scrollFrame(el, 320); // arrival
    scrollFrame(el, 0);
    expect(heroActive()).toBe("Show photo 1");
  });

  it("lets a touch gesture take over an in-flight jump", () => {
    render(
      <DetailHeroGallery postId="p1" title="Wallet" images={HERO} onOpenLightbox={vi.fn()} />,
    );
    const el = track("detail-hero-track", 320);
    fireEvent.click(screen.getByRole("tab", { name: "Show photo 3" }));
    scrollFrame(el, 2);
    expect(heroActive()).toBe("Show photo 3");

    fireEvent.touchStart(el, { touches: [{ clientX: 250, clientY: 40 }], changedTouches: [] });
    scrollFrame(el, 0);
    expect(heroActive()).toBe("Show photo 1");
  });

  it("releases the jump when its track is resized mid-flight", () => {
    render(
      <DetailHeroGallery postId="p1" title="Wallet" images={HERO} onOpenLightbox={vi.fn()} />,
    );
    track("detail-hero-track", 320);
    fireEvent.click(screen.getByRole("tab", { name: "Show photo 3" }));
    scrollFrame(screen.getByTestId("detail-hero-track"), 40);

    track("detail-hero-track", 500);
    scrollFrame(screen.getByTestId("detail-hero-track"), 0);
    expect(heroActive()).toBe("Show photo 1");
  });
});
