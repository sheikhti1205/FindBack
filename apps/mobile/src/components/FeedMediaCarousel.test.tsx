// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedMediaCarousel, type FeedCarouselImage } from "./FeedMediaCarousel";

function images(n: number): FeedCarouselImage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i + 1}`,
    fileUrl: `https://cdn.example/a${i + 1}.jpg`,
    alt: `Photo ${i + 1}`,
  }));
}

function track(): HTMLElement {
  return screen.getByTestId("feed-media-track");
}

/** jsdom has no layout: force a viewport width so scroll math is real. */
function setViewportWidth(el: HTMLElement, width: number): void {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
}

function scrollToIndex(el: HTMLElement, index: number, width = 300): void {
  setViewportWidth(el, width);
  el.scrollLeft = index * width;
  fireEvent.scroll(el);
}

function activeDotIndex(): string | null {
  const active = screen
    .getAllByTestId("carousel-dot")
    .find((d) => d.getAttribute("aria-current") === "true");
  return active?.getAttribute("data-index") ?? null;
}

afterEach(cleanup);

describe("FeedMediaCarousel media viewport", () => {
  it("renders a full-width 4:3 horizontal scroll-snap viewport, one slide per image", () => {
    render(<FeedMediaCarousel images={images(3)} onOpenImage={() => {}} />);
    const el = track();
    expect(el.className).toMatch(/overflow-x-auto/);
    expect(el.className).toMatch(/snap-x/);
    expect(el.className).toMatch(/snap-mandatory/);
    expect(screen.getAllByTestId("feed-slide")).toHaveLength(3);
    expect(screen.getAllByTestId("post-image-state")).toHaveLength(3);
    const viewport = screen.getByTestId("feed-media-viewport");
    expect(viewport.style.aspectRatio.replace(/\s/g, "")).toBe("4/3");
    // Wide content width: the viewport fills its container.
    expect(viewport.className).toMatch(/w-full/);
  });

  it("places the dots inside the media viewport", () => {
    render(<FeedMediaCarousel images={images(3)} onOpenImage={() => {}} />);
    const viewport = screen.getByTestId("feed-media-viewport");
    for (const dot of screen.getAllByTestId("carousel-dot")) {
      expect(viewport.contains(dot)).toBe(true);
    }
  });
});

describe("FeedMediaCarousel dots", () => {
  it("shows no dots for a single image", () => {
    render(<FeedMediaCarousel images={images(1)} onOpenImage={() => {}} />);
    expect(screen.queryAllByTestId("carousel-dot")).toHaveLength(0);
  });

  it("shows one dot per image for a few images", () => {
    render(<FeedMediaCarousel images={images(3)} onOpenImage={() => {}} />);
    expect(screen.getAllByTestId("carousel-dot")).toHaveLength(3);
  });

  it("renders compact windowed dots when there are many images", () => {
    render(<FeedMediaCarousel images={images(12)} onOpenImage={() => {}} />);
    const dots = screen.getAllByTestId("carousel-dot");
    expect(dots.length).toBeGreaterThan(1);
    expect(dots.length).toBeLessThan(12);
    expect(screen.getAllByTestId("carousel-dots-ellipsis").length).toBeGreaterThan(0);
  });

  it("tracks the active index from the scroll position", () => {
    render(<FeedMediaCarousel images={images(3)} onOpenImage={() => {}} />);
    expect(activeDotIndex()).toBe("0");
    scrollToIndex(track(), 1);
    expect(activeDotIndex()).toBe("1");
    scrollToIndex(track(), 2);
    expect(activeDotIndex()).toBe("2");
  });

  it("keeps the active index across ordinary rerenders", () => {
    const { rerender } = render(
      <FeedMediaCarousel images={images(4)} onOpenImage={() => {}} />,
    );
    scrollToIndex(track(), 2);
    expect(activeDotIndex()).toBe("2");
    // A parent rerender (new array identity, changed sibling data) must not
    // reset the reader's place in the carousel.
    rerender(<FeedMediaCarousel images={images(4)} onOpenImage={() => {}} />);
    expect(activeDotIndex()).toBe("2");
  });

  it("jumps to a photo when its dot is tapped", () => {
    render(<FeedMediaCarousel images={images(4)} onOpenImage={() => {}} />);
    fireEvent.click(screen.getAllByTestId("carousel-dot")[2]!);
    expect(activeDotIndex()).toBe("2");
  });
});

describe("FeedMediaCarousel tap vs swipe", () => {
  it("opens the lightbox at the current carousel index on a tap", () => {
    const onOpen = vi.fn();
    render(<FeedMediaCarousel images={images(4)} onOpenImage={onOpen} />);
    scrollToIndex(track(), 2);
    fireEvent.click(screen.getAllByTestId("feed-slide")[2]!);
    expect(onOpen).toHaveBeenCalledWith(2);
  });

  it("does not open the lightbox while swiping the carousel", () => {
    const onOpen = vi.fn();
    render(<FeedMediaCarousel images={images(4)} onOpenImage={onOpen} />);
    const el = track();
    scrollToIndex(el, 1);
    // A drag that starts elsewhere and "clicks" the slide after moving is a
    // swipe, never a tap.
    const slide = screen.getAllByTestId("feed-slide")[1]!;
    fireEvent.mouseDown(slide, { clientX: 260, clientY: 40 });
    fireEvent.click(slide, { clientX: 40, clientY: 44 });
    expect(onOpen).not.toHaveBeenCalled();
    // The swipe still changed which photo shows.
    expect(activeDotIndex()).toBe("1");
  });

  it("keeps the media out of the post link so a swipe can never navigate", () => {
    render(<FeedMediaCarousel images={images(3)} onOpenImage={() => {}} />);
    const viewport = screen.getByTestId("feed-media-viewport");
    expect(viewport.closest("a")).toBeNull();
    // No anchors anywhere in the media region.
    expect(viewport.querySelector("a")).toBeNull();
  });
});

describe("FeedMediaCarousel image states", () => {
  it("reserves the frame while loading and falls back with a label on failure", () => {
    render(<FeedMediaCarousel images={images(1)} onOpenImage={() => {}} />);
    const frame = screen.getByTestId("post-image-state");
    expect(frame.getAttribute("data-state")).toBe("loading");
    fireEvent.error(screen.getByAltText("Photo 1"));
    expect(screen.getByTestId("post-image-state").getAttribute("data-state")).toBe("failed");
    expect(screen.getByRole("img", { name: "Photo unavailable" })).toBeTruthy();
  });
});
