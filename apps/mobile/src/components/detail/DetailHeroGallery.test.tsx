// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailHeroGallery } from "./DetailHeroGallery";

afterEach(cleanup);

const IMAGES = [
  { fileUrl: "https://cdn.example/a1.jpg" },
  { fileUrl: "https://cdn.example/a2.jpg" },
  { fileUrl: "https://cdn.example/a3.jpg" },
];

function track(): HTMLElement {
  return screen.getByTestId("detail-hero-track");
}

/** jsdom has no layout: force a viewport width so scroll math is real. */
function scrollToIndex(el: HTMLElement, index: number, width = 300): void {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: width });
  el.scrollLeft = index * width;
  fireEvent.scroll(el);
}

describe("DetailHeroGallery continuous paging", () => {
  it("renders a scroll-snap track with every photo mounted side by side", () => {
    render(<DetailHeroGallery postId="p1" title="Lost camera" images={IMAGES} />);
    const el = track();
    expect(el.className).toMatch(/overflow-x-auto/);
    expect(el.className).toMatch(/snap-x/);
    expect(el.className).toMatch(/snap-mandatory/);
    // No fade-only swap: all three photos are in the DOM at once.
    expect(screen.getAllByTestId("detail-hero-slide")).toHaveLength(3);
    expect(screen.getByRole("img", { name: /photo 1 of 3/i })).toBeTruthy();
    expect(screen.getByRole("img", { name: /photo 2 of 3/i })).toBeTruthy();
    expect(screen.getByRole("img", { name: /photo 3 of 3/i })).toBeTruthy();
  });

  it("keeps the 16:10 cover frame with rounded corners", () => {
    render(<DetailHeroGallery postId="p1" title="Lost camera" images={IMAGES} />);
    const frame = track().parentElement!;
    expect(frame.className).toContain("rounded-[18px]");
    expect(frame.style.aspectRatio.replace(/\s/g, "")).toBe("16/10");
    expect(screen.getByRole("img", { name: /photo 1 of 3/i }).className).toContain("object-cover");
  });

  it("derives the counter and dots from scroll position, not from a tap index", () => {
    render(<DetailHeroGallery postId="p1" title="Lost camera" images={IMAGES} />);
    expect(screen.getByText("1 / 3")).toBeTruthy();
    scrollToIndex(track(), 1);
    expect(screen.getByText("2 / 3")).toBeTruthy();
    scrollToIndex(track(), 2);
    expect(screen.getByText("3 / 3")).toBeTruthy();
    // Dots follow the scroll too.
    const tabs = screen.getAllByRole("tab");
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
  });

  it("jumps to a photo when its dot is tapped", () => {
    render(<DetailHeroGallery postId="p1" title="Lost camera" images={IMAGES} />);
    fireEvent.click(screen.getByRole("tab", { name: /show photo 3/i }));
    expect(screen.getByText("3 / 3")).toBeTruthy();
  });

  it("keeps chrome off the pixels: no overlay arrows, counter lives below the frame", () => {
    render(<DetailHeroGallery postId="p1" title="Lost camera" images={IMAGES} />);
    expect(screen.queryByRole("button", { name: /previous photo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /next photo/i })).toBeNull();
    const counter = screen.getByText("1 / 3");
    expect(track().contains(counter)).toBe(false);
  });

  it("tapping a photo opens the lightbox at that index; swiping never opens", () => {
    const onOpen = vi.fn();
    render(
      <DetailHeroGallery postId="p1" title="Lost camera" images={IMAGES} onOpenLightbox={onOpen} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open photo 1 of 3 fullscreen/i }));
    expect(onOpen).toHaveBeenCalledWith(0, expect.any(Object));

    // A press that travels is a page gesture, never an open.
    const slide = screen.getAllByTestId("detail-hero-slide")[1]!;
    fireEvent.mouseDown(slide, { clientX: 260, clientY: 40 });
    fireEvent.click(slide, { clientX: 40, clientY: 44 });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("single photo has no counter or dots but keeps the cover frame", () => {
    render(
      <DetailHeroGallery postId="p1" title="Lost camera" images={[IMAGES[0]!]} />,
    );
    expect(screen.getByRole("img", { name: /photo for lost camera/i }).className).toContain(
      "object-cover",
    );
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText(/\/ 1/)).toBeNull();
  });
});
