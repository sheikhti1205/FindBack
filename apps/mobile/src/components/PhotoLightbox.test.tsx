// @vitest-environment jsdom
//
// Real-timer policy (Wave B): this file asserts animation frames, so it
// never uses fake timers — mixing them poisons framer's rAF loop for the
// rest of the file. Every wait carries an explicit generous timeout.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { PhotoLightbox } from "./PhotoLightbox";
import { resetBackInterceptors } from "./backNavigation";

const EXIT_TIMEOUT = { timeout: 3000 };

afterEach(() => {
  cleanup();
  resetBackInterceptors();
  vi.restoreAllMocks();
});

function photo(id: string) {
  return { id, previewUrl: `blob:${id}` };
}

describe("PhotoLightbox", () => {
  it("renders nothing without a photo", () => {
    const { container } = render(<PhotoLightbox photo={null} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a full-size dialog labelled with photo position", () => {
    render(<PhotoLightbox photo={photo("p1")} index={0} total={2} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Photo 1 of 2" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const img = screen.getByRole("img", { name: "Photo 1 of 2" }) as HTMLImageElement;
    expect(img.src).toContain("blob:p1");
  });

  it("closes from the close button and from Escape", () => {
    const onClose = vi.fn();
    render(<PhotoLightbox photo={photo("p1")} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close photo preview/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("grows the panel out of the tapped thumbnail's rect", async () => {
    const rect = {
      x: 100, y: 100, top: 100, left: 100, right: 400, bottom: 300,
      width: 300, height: 200, toJSON: () => ({}),
    } as DOMRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);

    render(
      <PhotoLightbox
        photo={photo("p1")}
        index={0}
        total={1}
        originRect={{ x: 10, y: 10, width: 60, height: 60 }}
        onClose={vi.fn()}
      />,
    );

    const panel = screen.getByTestId("photo-lightbox-panel");
    // FLIP origin: thumbnail (10,10,60px) relative to the panel's final box.
    expect(panel.style.transformOrigin).toBe("top left");
    expect(panel.style.transform).toContain("-90px");
    expect(panel.style.transform).toContain("scale(0.2)");

    await waitFor(
      () => {
        expect(panel.style.transform === "" || panel.style.transform === "none").toBe(true);
      },
      EXIT_TIMEOUT,
    );
  });

  it("falls back to a centered scale when there is no origin rect", async () => {
    render(<PhotoLightbox photo={photo("p1")} index={0} total={1} onClose={vi.fn()} />);
    const panel = screen.getByTestId("photo-lightbox-panel");
    expect(panel.style.transformOrigin).toBe("center center");
    expect(panel.style.transform).toContain("scale(0.97");
    await waitFor(
      () => {
        expect(panel.style.transform === "" || panel.style.transform === "none").toBe(true);
      },
      EXIT_TIMEOUT,
    );
  });

  it("locks body scroll while open and restores it after the exit", async () => {
    const { rerender } = render(<PhotoLightbox photo={photo("p1")} onClose={vi.fn()} />);
    expect(document.body.style.overflow).toBe("hidden");

    rerender(<PhotoLightbox photo={null} onClose={vi.fn()} />);
    // Still exiting: the overlay is present but no longer interactive.
    expect(screen.getByTestId("photo-lightbox")).toBeTruthy();
    expect(screen.getByTestId("photo-lightbox").style.pointerEvents).toBe("none");

    await waitFor(
      () => {
        expect(document.body.style.overflow).toBe("");
        expect(screen.queryByTestId("photo-lightbox")).toBeNull();
      },
      EXIT_TIMEOUT,
    );
  });

  it("pages continuously through the gallery at fit zoom without closing", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onNext = vi.fn();
    const photos = [photo("p1"), photo("p2"), photo("p3")];
    render(
      <PhotoLightbox
        photo={photos[0]!}
        index={0}
        total={3}
        photos={photos}
        onSelect={onSelect}
        onClose={onClose}
        onPrev={vi.fn()}
        onNext={onNext}
      />,
    );
    const stage = screen.getByTestId("lightbox-stage");
    // Native scroll-snap paging, same contract as the feed carousel.
    expect(stage.className).toMatch(/overflow-x-auto/);
    expect(stage.className).toMatch(/snap-x/);
    expect(stage.className).toMatch(/snap-mandatory/);
    // No fade-only swap: every gallery photo is mounted side by side.
    expect(screen.getAllByTestId("lightbox-slide")).toHaveLength(3);

    // jsdom has no layout: force a viewport width so scroll math is real.
    Object.defineProperty(stage, "clientWidth", { configurable: true, value: 300 });
    stage.scrollLeft = 300;
    fireEvent.scroll(stage);

    // The swipe pages through scroll → onSelect, never close or double-step.
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it("syncs the track to parent-driven navigation (arrows, keys, thumbnails)", () => {
    const onSelect = vi.fn();
    const photos = [photo("p1"), photo("p2"), photo("p3")];
    const { rerender } = render(
      <PhotoLightbox
        photo={photos[0]!}
        index={0}
        total={3}
        photos={photos}
        onSelect={onSelect}
        onClose={vi.fn()}
        onPrev={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    const stage = screen.getByTestId("lightbox-stage");
    Object.defineProperty(stage, "clientWidth", { configurable: true, value: 300 });

    rerender(
      <PhotoLightbox
        photo={photos[2]!}
        index={2}
        total={3}
        photos={photos}
        onSelect={onSelect}
        onClose={vi.fn()}
        onPrev={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    expect(stage.scrollLeft).toBe(600);

    fireEvent.click(screen.getByRole("button", { name: "View photo 1" }));
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it("locks paging while zoomed and keeps pinch/double-tap zoom plus pan", () => {
    const photos = [photo("p1"), photo("p2")];
    render(
      <PhotoLightbox
        photo={photos[0]!}
        index={0}
        total={2}
        photos={photos}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onPrev={vi.fn()}
        onNext={vi.fn()}
      />,
    );
    const stage = screen.getByTestId("lightbox-stage");

    // Double-tap zooms to 200%.
    const tap = { clientX: 150, clientY: 200 };
    fireEvent.touchStart(stage, { touches: [tap] });
    fireEvent.touchEnd(stage, { touches: [], changedTouches: [tap] });
    fireEvent.touchStart(stage, { touches: [tap] });
    fireEvent.touchEnd(stage, { touches: [], changedTouches: [tap] });
    expect(screen.getByText("200%")).toBeTruthy();

    // Paging locks while zoomed so drags pan instead of changing photo.
    expect(stage.className).toMatch(/overflow-hidden/);
    expect(stage.className).not.toMatch(/overflow-x-auto/);
    expect(screen.getByText(/Reset zoom to swipe photos/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(screen.getByText("100%")).toBeTruthy();
    expect(stage.className).toMatch(/overflow-x-auto/);
  });

  it("crossfades the loading shimmer out when the image loads", async () => {
    render(<PhotoLightbox photo={photo("p1")} index={0} total={2} onClose={vi.fn()} />);
    const frame = screen.getByTestId("lightbox-image-frame");
    expect(frame.dataset.state).toBe("loading");
    const shimmer = screen.getByTestId("lightbox-shimmer");
    expect(shimmer.style.opacity).toBe("1");

    const img = screen.getByRole("img", { name: "Photo 1 of 2" });
    fireEvent.load(img);

    expect(frame.dataset.state).toBe("loaded");
    await waitFor(
      () => {
        expect(screen.getByTestId("lightbox-shimmer").style.opacity).toBe("0");
        expect(screen.getByRole("img", { name: "Photo 1 of 2" }).style.opacity).toBe("1");
      },
      EXIT_TIMEOUT,
    );
  });

  it("crossfades to the failure fallback when the image errors", async () => {
    render(<PhotoLightbox photo={photo("p1")} index={0} total={2} onClose={vi.fn()} />);
    const frame = screen.getByTestId("lightbox-image-frame");

    fireEvent.error(screen.getByRole("img", { name: "Photo 1 of 2" }));

    expect(frame.dataset.state).toBe("failed");
    expect(screen.getByText("Photo unavailable")).toBeTruthy();
    await waitFor(
      () => {
        expect(screen.getByTestId("lightbox-shimmer").style.opacity).toBe("0");
      },
      EXIT_TIMEOUT,
    );
  });

  it("offers previous/next buttons and arrow keys only with more than one photo", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(
      <PhotoLightbox
        photo={photo("p1")}
        index={0}
        total={2}
        onPrev={onPrev}
        onNext={onNext}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Previous photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    expect(onPrev).toHaveBeenCalledTimes(2);
    expect(onNext).toHaveBeenCalledTimes(2);

    rerender(
      <PhotoLightbox
        photo={photo("p1")}
        index={0}
        total={1}
        onPrev={onPrev}
        onNext={onNext}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Previous photo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
  });

  it("removes the overlay when closed mid-entrance", async () => {
    const { rerender } = render(<PhotoLightbox photo={photo("p1")} onClose={vi.fn()} />);
    rerender(<PhotoLightbox photo={null} onClose={vi.fn()} />);
    await waitFor(
      () => {
        expect(screen.queryByTestId("photo-lightbox")).toBeNull();
      },
      EXIT_TIMEOUT,
    );
  });

  it("settles without travel under reduced motion", async () => {
    render(
      <MotionConfig reducedMotion="always">
        <PhotoLightbox photo={photo("p1")} index={0} total={2} onClose={vi.fn()} />
      </MotionConfig>,
    );
    const panel = screen.getByTestId("photo-lightbox-panel");
    await waitFor(
      () => {
        expect(panel.style.opacity).toBe("1");
        expect(panel.style.transform === "" || panel.style.transform === "none").toBe(true);
      },
      EXIT_TIMEOUT,
    );
  });
});
