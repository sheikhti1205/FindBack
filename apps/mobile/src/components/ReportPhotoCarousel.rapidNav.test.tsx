// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhotoLightboxOriginRect } from "./PhotoLightbox";
import { ReportPhotoCarousel, type ReportMediaPhoto } from "./ReportPhotoCarousel";

/**
 * CF-020 rapid dot → action regression.
 *
 * The recorded browser failure: tapping "Go to photo 2" starts a smooth scroll;
 * the track then reports intermediate positions (2px, 88px of a 300px page)
 * that were interpreted as a new selection, rebinding the action row to photo 1
 * before the follow-up "Move right" click. The click then moved photo 1.
 *
 * These tests assert photo IDENTITY, not just an index. jsdom has no layout, so
 * the viewport width is fixed and scroll frames are reported explicitly — the
 * same partial positions the browser produced, with no sleeps and no delays.
 */

const PHOTOS: ReportMediaPhoto[] = [
  { id: "A", webPath: "blob:photo-a" },
  { id: "B", webPath: "blob:photo-b" },
  { id: "C", webPath: "blob:photo-c" },
];
const WIDTH = 300;

function mount(photos: readonly ReportMediaPhoto[] = PHOTOS) {
  const handlers = {
    onRemove: vi.fn<(id: string) => void>(),
    onMove: vi.fn<(id: string, direction: "earlier" | "later") => void>(),
    onMakeCover: vi.fn<(id: string) => void>(),
    onPreview: vi.fn<(id: string, origin?: PhotoLightboxOriginRect) => void>(),
  };
  const view = render(
    <ReportPhotoCarousel
      photos={photos}
      onRemove={handlers.onRemove}
      onMove={handlers.onMove}
      onMakeCover={handlers.onMakeCover}
      onPreview={handlers.onPreview}
      disabled={false}
    />,
  );
  Object.defineProperty(track(), "clientWidth", { configurable: true, value: WIDTH });
  return { ...view, handlers };
}

function track(): HTMLElement {
  return screen.getByTestId("report-photo-track");
}

/** A layout change (rotation / keyboard) while a jump is in flight. */
function setWidth(width: number): void {
  Object.defineProperty(track(), "clientWidth", { configurable: true, value: width });
}

/** One scroll event as the browser reports it mid-animation. */
function scrollFrame(left: number): void {
  const el = track();
  el.scrollLeft = left;
  fireEvent.scroll(el);
}

function position(): string {
  return (screen.getByTestId("report-photo-position").textContent ?? "").replace(/\s+/g, " ").trim();
}

function activePhotoId(): string | null {
  const slide = screen
    .getAllByTestId("report-photo-slide")
    .find((node) => node.getAttribute("data-active") === "true");
  return slide?.getAttribute("data-photo-id") ?? null;
}

const GESTURES: Array<[string, () => void]> = [
  ["pointer", () => fireEvent.pointerDown(track(), { clientX: 250, clientY: 40 })],
  [
    "touch",
    () =>
      fireEvent.touchStart(track(), {
        touches: [{ clientX: 250, clientY: 40 }],
        changedTouches: [],
      }),
  ],
  ["wheel", () => fireEvent.wheel(track(), { deltaY: 24 })],
];

afterEach(cleanup);

describe("CF-020 rapid dot → action", () => {
  it("keeps the action row bound to the chosen photo through intermediate scroll frames", () => {
    const { handlers } = mount();

    // Exactly the recorded sequence: choose photo 2, then act before the smooth
    // scroll finishes, while the track still reports positions near page 1.
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[1]!);
    scrollFrame(2);
    scrollFrame(88);

    expect(position()).toBe("2 / 3");
    expect(activePhotoId()).toBe("B");
    expect(screen.getAllByTestId("report-photo-dot")[1]!.getAttribute("aria-current")).toBe("true");

    // Identity-bound assertion: the actual photo, not "index 1".
    fireEvent.click(screen.getByLabelText("Move photo 2 right"));
    expect(handlers.onMove).toHaveBeenCalledTimes(1);
    expect(handlers.onMove).toHaveBeenCalledWith("B", "later");
  });

  it("does not fire a cover or removal action against the wrong photo during the jump", () => {
    const { handlers } = mount();
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[2]!);
    scrollFrame(60);
    scrollFrame(120);

    fireEvent.click(screen.getByLabelText("Make photo 3 the cover"));
    expect(handlers.onMakeCover).toHaveBeenCalledWith("C");
    fireEvent.click(screen.getByLabelText("Remove photo 3"));
    expect(handlers.onRemove).toHaveBeenCalledWith("C");
    expect(handlers.onMove).not.toHaveBeenCalled();
  });

  it("hands selection back to scroll position once the jump arrives", () => {
    mount();
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[1]!);
    scrollFrame(2);
    expect(position()).toBe("2 / 3");

    // Arrival: the track sits exactly on page 2, so tracking resumes.
    scrollFrame(WIDTH);
    expect(position()).toBe("2 / 3");

    // An ordinary later scroll now moves the selection again.
    scrollFrame(0);
    expect(position()).toBe("1 / 3");
    expect(activePhotoId()).toBe("A");
    scrollFrame(WIDTH * 2);
    expect(position()).toBe("3 / 3");
    expect(activePhotoId()).toBe("C");
  });

  for (const [name, gesture] of GESTURES) {
    it(`lets a ${name} gesture take over an in-flight jump`, () => {
      mount();
      fireEvent.click(screen.getAllByTestId("report-photo-dot")[2]!);
      scrollFrame(2);
      expect(position()).toBe("3 / 3");

      gesture();
      scrollFrame(0);
      expect(position()).toBe("1 / 3");
      expect(activePhotoId()).toBe("A");
    });
  }

  it("does not guard a jump that never travels", () => {
    mount();
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[1]!);
    scrollFrame(WIDTH);
    expect(position()).toBe("2 / 3");

    // Asking again for the page already shown must not swallow the next scroll.
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[1]!);
    scrollFrame(0);
    expect(position()).toBe("1 / 3");
    expect(activePhotoId()).toBe("A");
  });

  it("follows the anchored photo after a reorder without rebinding mid-jump", () => {
    const { rerender, handlers } = mount();
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[1]!);
    scrollFrame(2);

    // The composer moves B to the end, like the real onMove parent update.
    const reordered = [PHOTOS[0]!, PHOTOS[2]!, PHOTOS[1]!];
    rerender(
      <ReportPhotoCarousel
        photos={reordered}
        onRemove={handlers.onRemove}
        onMove={handlers.onMove}
        onMakeCover={handlers.onMakeCover}
        onPreview={handlers.onPreview}
        disabled={false}
      />,
    );
    scrollFrame(20);

    expect(position()).toBe("3 / 3");
    expect(activePhotoId()).toBe("B");
    expect(screen.getByLabelText("Move photo 3 left")).toBeTruthy();
  });

  it("keeps the active photo across an ordinary rerender with unchanged order", () => {
    const { rerender, handlers } = mount();
    scrollFrame(WIDTH);
    expect(activePhotoId()).toBe("B");
    rerender(
      <ReportPhotoCarousel
        photos={PHOTOS}
        onRemove={handlers.onRemove}
        onMove={handlers.onMove}
        onMakeCover={handlers.onMakeCover}
        onPreview={handlers.onPreview}
        disabled={false}
      />,
    );
    expect(activePhotoId()).toBe("B");
  });
});

describe("CF-020 jump guard boundaries", () => {
  it("releases the jump when the track is resized mid-flight", () => {
    mount();
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[2]!);
    scrollFrame(120);
    expect(position()).toBe("3 / 3");

    // Rotation: the browser still animates the pixels captured at arm time, so
    // the selected page is no longer reachable. The action row must follow what
    // the track actually shows instead of latching onto photo 3.
    setWidth(700);
    scrollFrame(0);
    expect(position()).toBe("1 / 3");
    expect(screen.getByLabelText("Remove photo 1")).toBeTruthy();
    expect(screen.queryByLabelText("Remove photo 3")).toBeNull();
  });

  it("abandons the jump when the photo count changes", () => {
    const { rerender, handlers } = mount();
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[2]!);
    scrollFrame(120);

    rerender(
      <ReportPhotoCarousel
        photos={PHOTOS.slice(0, 2)}
        onRemove={handlers.onRemove}
        onMove={handlers.onMove}
        onMakeCover={handlers.onMakeCover}
        onPreview={handlers.onPreview}
        disabled={false}
      />,
    );
    // Clamped to the last remaining page, then ordinary tracking resumes.
    scrollFrame(0);
    expect(position()).toBe("1 / 2");
    expect(activePhotoId()).toBe("A");
  });

  it("a newer jump supersedes the in-flight one", () => {
    mount();
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[2]!);
    scrollFrame(2);
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[1]!);
    scrollFrame(2);
    expect(position()).toBe("2 / 3");
    scrollFrame(WIDTH);
    expect(position()).toBe("2 / 3");
    expect(activePhotoId()).toBe("B");
  });
});

/**
 * Native releases that are not pointer gestures. A keyboard scroll fires a
 * keydown before it moves the track; any scroll that *stops* short of the armed
 * page fires `scrollend` there. Neither is a smooth-scroll animation frame, and
 * neither may leave the action row bound to a page that is no longer coming.
 *
 * The round-2 review measured the keyboard case: arm page 3, press ArrowRight,
 * the track settles on page 2 while the counter still reads 3 / 3.
 */
describe("CF-020 jump guard native releases", () => {
  function scrollEndAt(left: number): void {
    const el = track();
    el.scrollLeft = left;
    // fireEvent wraps the dispatch in act(), so the hook's state update is
    // flushed before the assertion — a raw dispatchEvent would leave it pending.
    fireEvent(el, new Event("scrollend"));
  }

  it("lets a keyboard scroll take over an in-flight jump", () => {
    const { handlers } = mount();
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[2]!);
    scrollFrame(2);
    expect(position()).toBe("3 / 3");

    fireEvent.keyDown(track(), { key: "ArrowRight" });
    scrollFrame(WIDTH);
    expect(position()).toBe("2 / 3");
    expect(activePhotoId()).toBe("B");

    // The action row must act on the photo the track is showing, not the dot.
    fireEvent.click(screen.getByLabelText("Move photo 2 right"));
    expect(handlers.onMove).toHaveBeenCalledWith("B", "later");
  });

  it("reports the landed page when a scrollend stops short of the armed target", () => {
    mount();
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[2]!);
    scrollFrame(2);
    expect(position()).toBe("3 / 3");

    // No further scroll event: the stop itself must re-derive the page.
    scrollEndAt(WIDTH);
    expect(position()).toBe("2 / 3");
    expect(activePhotoId()).toBe("B");

    scrollFrame(WIDTH * 2);
    expect(position()).toBe("3 / 3");
  });

  it("releases the guard when scrollend lands on the armed page", () => {
    mount();
    fireEvent.click(screen.getAllByTestId("report-photo-dot")[2]!);
    scrollEndAt(WIDTH * 2);
    expect(position()).toBe("3 / 3");
    expect(activePhotoId()).toBe("C");

    // Tracking resumed: an ordinary later scroll moves the selection.
    scrollFrame(WIDTH);
    expect(position()).toBe("2 / 3");
    expect(activePhotoId()).toBe("B");
  });

  it("does not select a page from a track with no layout width", () => {
    mount();
    Object.defineProperty(track(), "clientWidth", { configurable: true, value: 0 });
    Object.defineProperty(track(), "offsetWidth", { configurable: true, value: 0 });

    scrollFrame(120);
    expect(position()).toBe("1 / 3");
    expect(activePhotoId()).toBe("A");
  });
});
