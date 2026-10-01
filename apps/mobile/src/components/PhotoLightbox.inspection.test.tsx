// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoLightbox } from "./PhotoLightbox";
import { consumeBackIntercept, resetBackInterceptors } from "./backNavigation";

const photos = [1, 2, 3].map((i) => ({ id: `p${i}`, previewUrl: `https://example.com/${i}.jpg` }));

function Viewer() {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(true);
  return <PhotoLightbox photo={open ? photos[index]! : null} photos={photos} title="Lost wallet" index={index} total={photos.length}
    onSelect={setIndex} onClose={() => setOpen(false)} onNext={() => setIndex((i) => (i + 1) % photos.length)} onPrev={() => setIndex((i) => (i + 2) % photos.length)} />;
}

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 300, height: 300, top: 0, left: 0, right: 300, bottom: 300, toJSON: () => ({}),
  });
});
afterEach(() => { cleanup(); resetBackInterceptors(); vi.restoreAllMocks(); });

function drag(x1: number, y1: number, x2: number, y2: number) {
  const stage = screen.getByTestId("lightbox-stage");
  fireEvent.touchStart(stage, { touches: [{ clientX: x1, clientY: y1 }] });
  fireEvent.touchMove(stage, { touches: [{ clientX: x2, clientY: y2 }] });
  fireEvent.touchEnd(stage, { touches: [], changedTouches: [{ clientX: x2, clientY: y2 }] });
}

describe("photo inspection", () => {
  it("selects a thumbnail directly and keeps the current selection announced", async () => {
    render(<Viewer />);
    expect(screen.getByText("Lost wallet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View photo 3" }));
    expect(screen.getByRole("dialog", { name: "Photo 3 of 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "View photo 3" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "View photo 1" }).getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(screen.getByRole("img", { name: "Photo 3 of 3" }).getAttribute("src")).toBe(photos[2]!.previewUrl));
  });

  it("pans while zoomed instead of changing photos, then resets for explicit navigation", () => {
    render(<Viewer />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    drag(200, 150, 100, 150);
    expect(screen.getByRole("dialog", { name: "Photo 1 of 3" })).toBeTruthy();
    const image = screen.getByTestId("lightbox-zoom-content");
    expect(image.style.transform).toContain("-100px");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    expect(image.style.transform).toContain("-60px");
    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    expect(screen.getByRole("dialog", { name: "Photo 2 of 3" })).toBeTruthy();
    expect(screen.getByTestId("lightbox-zoom-content").style.transform).toContain("scale(1)");
    drag(220, 150, 80, 150);
    expect(screen.getByRole("dialog", { name: "Photo 3 of 3" })).toBeTruthy();
  });

  it("pinches with bounded zoom, and does not turn pinch release into a swipe", () => {
    render(<Viewer />);
    const stage = screen.getByTestId("lightbox-stage");
    fireEvent.touchStart(stage, { touches: [{ clientX: 125, clientY: 150 }, { clientX: 175, clientY: 150 }] });
    fireEvent.touchMove(stage, { touches: [{ clientX: 25, clientY: 150 }, { clientX: 275, clientY: 150 }] });
    expect(screen.getByTestId("lightbox-zoom-content").style.transform).toContain("scale(4)");
    fireEvent.touchEnd(stage, { touches: [], changedTouches: [{ clientX: 25, clientY: 150 }] });
    expect(screen.getByRole("dialog", { name: "Photo 1 of 3" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(screen.getByTestId("lightbox-zoom-content").style.transform).toContain("scale(1)");
  });

  it("does not restore stale zoom when returning to a previously inspected photo", () => {
    render(<Viewer />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByTestId("lightbox-zoom-content").style.transform).toContain("scale(2)");
    fireEvent.click(screen.getByRole("button", { name: "View photo 2" }));
    fireEvent.click(screen.getByRole("button", { name: "View photo 1" }));
    expect(screen.getByRole("dialog", { name: "Photo 1 of 3" })).toBeTruthy();
    expect(screen.getByTestId("lightbox-zoom-content").style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("keeps a photo smaller than the stage visible at both pan boundaries", () => {
    render(<Viewer />);
    const photo = screen.getByRole("img", { name: "Photo 1 of 3" });
    Object.defineProperties(photo, {
      naturalWidth: { value: 100 },
      naturalHeight: { value: 100 },
    });
    fireEvent.load(photo);
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    drag(150, 150, 1000, 1000);
    // Natural-size 100px image at 4× is 400px in a 300px stage: only 50px
    // of travel is safe, not the 450px allowed for a full-stage image.
    expect(screen.getByTestId("lightbox-zoom-content").style.transform).toBe("translate(50px, 50px) scale(4)");
    drag(150, 150, -1000, -1000);
    expect(screen.getByTestId("lightbox-zoom-content").style.transform).toBe("translate(-50px, -50px) scale(4)");
  });

  it("supports keyboard zoom/reset and Android Back closes the viewer", async () => {
    render(<Viewer />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "+" });
    expect(screen.getByTestId("lightbox-zoom-content").style.transform).toContain("scale(2)");
    fireEvent.keyDown(dialog, { key: "0" });
    expect(screen.getByTestId("lightbox-zoom-content").style.transform).toContain("scale(1)");
    expect(consumeBackIntercept()).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
