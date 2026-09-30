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

describe("DetailHeroGallery", () => {
  it("renders a stable cover hero with counter and dots", () => {
    render(<DetailHeroGallery postId="p1" title="Lost camera" images={IMAGES} />);
    const img = screen.getByRole("img", { name: /photo 1 of 3/i });
    expect(img.className).toContain("object-cover");
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: /report photos/i })).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("swipe left advances, swipe right goes back", () => {
    render(<DetailHeroGallery postId="p1" title="Lost camera" images={IMAGES} />);
    const stage = screen.getByTestId("detail-hero-stage");
    // Left swipe -> next.
    fireEvent.touchStart(stage, { touches: [{ clientX: 200, clientY: 100 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 80, clientY: 105 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 80, clientY: 105 }] });
    expect(screen.getByRole("img", { name: /photo 2 of 3/i })).toBeTruthy();
    // Right swipe -> previous.
    fireEvent.touchStart(stage, { touches: [{ clientX: 80, clientY: 100 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 200, clientY: 102 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 200, clientY: 102 }] });
    expect(screen.getByRole("img", { name: /photo 1 of 3/i })).toBeTruthy();
  });

  it("ignores vertical gestures and small drags", () => {
    render(<DetailHeroGallery postId="p1" title="Lost camera" images={IMAGES} />);
    const stage = screen.getByTestId("detail-hero-stage");
    fireEvent.touchStart(stage, { touches: [{ clientX: 150, clientY: 50 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 140, clientY: 250 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 140, clientY: 250 }] });
    expect(screen.getByRole("img", { name: /photo 1 of 3/i })).toBeTruthy();
    fireEvent.touchStart(stage, { touches: [{ clientX: 150, clientY: 100 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 160, clientY: 102 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 160, clientY: 102 }] });
    expect(screen.getByRole("img", { name: /photo 1 of 3/i })).toBeTruthy();
  });

  it("prev/next buttons and dots update the count", () => {
    render(<DetailHeroGallery postId="p1" title="Lost camera" images={IMAGES} />);
    fireEvent.click(screen.getByRole("button", { name: /next photo/i }));
    expect(screen.getByText("2 / 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /previous photo/i }));
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /show photo 3/i }));
    expect(screen.getByText("3 / 3")).toBeTruthy();
  });

  it("tapping the hero opens the lightbox", () => {
    const onOpen = vi.fn();
    render(
      <DetailHeroGallery postId="p1" title="Lost camera" images={IMAGES} onOpenLightbox={onOpen} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open photo 1 of 3 fullscreen/i }));
    expect(onOpen).toHaveBeenCalledWith(0, expect.any(Object));
  });

  it("single photo has no nav controls but keeps the cover frame", () => {
    render(
      <DetailHeroGallery postId="p1" title="Lost camera" images={[IMAGES[0]!]} />,
    );
    expect(screen.getByRole("img", { name: /photo for lost camera/i }).className).toContain(
      "object-cover",
    );
    expect(screen.queryByRole("button", { name: /next photo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /previous photo/i })).toBeNull();
  });
});
