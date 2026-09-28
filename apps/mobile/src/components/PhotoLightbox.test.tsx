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

  it("crossfades to the next photo with directional travel", async () => {
    const { rerender } = render(
      <PhotoLightbox photo={photo("p1")} index={0} total={2} onClose={vi.fn()} />,
    );
    expect(screen.getAllByTestId("photo-layer")).toHaveLength(1);

    rerender(<PhotoLightbox photo={photo("p2")} index={1} total={2} onClose={vi.fn()} />);

    const layers = screen.getAllByTestId("photo-layer");
    expect(layers).toHaveLength(2);
    const entering = layers.find((layer) => layer.querySelector('img[alt="Photo 2 of 2"]'));
    expect(entering).toBeTruthy();
    // pageForwardVariants.hidden — enters from the trailing edge.
    expect(entering!.style.transform).toContain("16px");
    expect(screen.getByRole("dialog", { name: "Photo 2 of 2" })).toBeTruthy();

    await waitFor(
      () => {
        expect(screen.getAllByTestId("photo-layer")).toHaveLength(1);
      },
      EXIT_TIMEOUT,
    );
  });

  it("crossfades back to the previous photo in the reverse direction", async () => {
    const { rerender } = render(
      <PhotoLightbox photo={photo("p2")} index={1} total={2} onClose={vi.fn()} />,
    );

    rerender(<PhotoLightbox photo={photo("p1")} index={0} total={2} onClose={vi.fn()} />);

    const layers = screen.getAllByTestId("photo-layer");
    expect(layers).toHaveLength(2);
    const entering = layers.find((layer) => layer.querySelector('img[alt="Photo 1 of 2"]'));
    expect(entering).toBeTruthy();
    // pageBackwardVariants.hidden — enters from the leading edge.
    expect(entering!.style.transform).toContain("-16px");

    await waitFor(
      () => {
        expect(screen.getAllByTestId("photo-layer")).toHaveLength(1);
      },
      EXIT_TIMEOUT,
    );
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
