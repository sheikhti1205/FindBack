// @vitest-environment jsdom
//
// Real-timer policy (Wave B): slide enter/exit assertions wait on real
// animation frames; no fake timers in this file.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReportMediaPicker } from "./ReportMediaPicker";
import type { PickedPhoto } from "../services/photo";
import type { ReportMediaPickerProps } from "./ReportMediaPicker";

afterEach(cleanup);

function createMockPhoto(id: string, format = "jpg"): PickedPhoto {
  return {
    id,
    nativeUri: `file:///mock/${id}`,
    webPath: `blob:mock/${id}`,
    format,
  };
}

function getDefaultProps(overrides: Partial<ReportMediaPickerProps> = {}) {
  return {
    photos: [] as PickedPhoto[],
    onAddCamera: vi.fn(),
    onAddGallery: vi.fn(),
    onRemove: vi.fn(),
    onMove: vi.fn(),
    onMakeCover: vi.fn(),
    onPreview: vi.fn(),
    disabled: false,
    ...overrides,
  };
}

function slides(): HTMLElement[] {
  return screen.getAllByTestId("report-photo-slide");
}

function slideButtons(): HTMLButtonElement[] {
  return screen.getAllByTestId("report-photo-slide-button") as HTMLButtonElement[];
}

/** Activate a slide the way a person does: tap its dot. */
function goToPhoto(position: number) {
  fireEvent.click(screen.getByRole("button", { name: `Go to photo ${position}` }));
}

/** Press and release in place — the tap half of the pager's tap/swipe split. */
function tap(element: HTMLElement, x = 10, y = 10) {
  fireEvent.mouseDown(element, { clientX: x, clientY: y });
  fireEvent.click(element, { clientX: x, clientY: y });
}

describe("ReportMediaPicker", () => {
  it("renders header with Photos and count", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
    render(<ReportMediaPicker {...props} />);
    expect(screen.getByText("Photos")).toBeTruthy();
    expect(screen.getByText("2/5")).toBeTruthy();
  });

  it("shows camera and gallery buttons with correct aria-labels", () => {
    const props = getDefaultProps();
    render(<ReportMediaPicker {...props} />);
    expect(screen.getByRole("button", { name: "Take photo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose up to 5 photos" })).toBeTruthy();
  });

  it("add and per-photo actions have at least 48px hit targets without losing their actions", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
    render(<ReportMediaPicker {...props} />);

    const camera = screen.getByRole("button", { name: "Take photo" }) as HTMLButtonElement;
    expect(parseFloat(camera.style.width)).toBeGreaterThanOrEqual(48);
    expect(parseFloat(camera.style.height)).toBeGreaterThanOrEqual(48);

    const remove = screen.getByRole("button", { name: "Remove photo 1" }) as HTMLButtonElement;
    const moveRight = screen.getByRole("button", { name: "Move photo 1 right" }) as HTMLButtonElement;
    expect(parseFloat(remove.style.width)).toBeGreaterThanOrEqual(48);
    expect(parseFloat(remove.style.height)).toBeGreaterThanOrEqual(48);
    expect(parseFloat(moveRight.style.width)).toBeGreaterThanOrEqual(48);
    expect(parseFloat(moveRight.style.height)).toBeGreaterThanOrEqual(48);

    fireEvent.click(remove);
    fireEvent.click(moveRight);
    expect(props.onRemove).toHaveBeenCalledWith("p1");
    expect(props.onMove).toHaveBeenCalledWith("p1", "later");
  });

  it("uses theme surfaces and readable theme ink for photo actions and labels", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1")] });
    render(<ReportMediaPicker {...props} />);

    const camera = screen.getByRole("button", { name: "Take photo" }) as HTMLButtonElement;
    expect(camera.className).toContain("bg-surface-container");
    expect(camera.className).toContain("text-on-surface");
    // Nothing paints a raw colour: the section's ink comes from theme tokens.
    expect(screen.getByText("Photos").className).toContain("text-on-surface");
    const remove = screen.getByRole("button", { name: "Remove photo 1" }) as HTMLButtonElement;
    expect(remove.className).toContain("bg-surface-container");
    expect(remove.className).toContain("text-on-surface");
  });

  it("renders one snapped slide per photo in a single horizontal track", () => {
    const props = getDefaultProps({
      photos: [createMockPhoto("p1"), createMockPhoto("p2"), createMockPhoto("p3")],
    });
    render(<ReportMediaPicker {...props} />);

    expect(slides()).toHaveLength(3);
    const track = screen.getByTestId("report-photo-track");
    expect(track.className).toContain("snap-x");
    expect(track.className).toContain("overflow-x-auto");
    expect(screen.getByTestId("report-photo-position").textContent).toBe("1 / 3");
  });

  it("never crops a photo: the slide box takes the photo's own ratio and contains it", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
    render(<ReportMediaPicker {...props} />);

    const button = slideButtons()[0]!;
    // Before the image reports its size the box holds the default ratio…
    expect(button.style.aspectRatio.replace(/\s/g, "")).toBe("4/3");
    expect(button.style.aspectRatio).not.toBe("1 / 1");
    // …bounded so a panorama cannot collapse and a portrait cannot take the page.
    expect(parseFloat(button.style.minHeight)).toBeGreaterThanOrEqual(120);
    expect(button.style.maxHeight).not.toBe("");
    // …and the image is contained, never cover-cropped.
    const image = button.querySelector("img")!;
    expect(image.className).toContain("object-contain");
    expect(image.className).not.toContain("object-cover");
  });

  it("derives the slide box from the ratio the photo actually reports", async () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1")] });
    render(<ReportMediaPicker {...props} />);

    const button = slideButtons()[0]!;
    const image = button.querySelector("img")!;
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 1600 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 900 });
    fireEvent.load(image);

    await waitFor(() => {
      expect(Number.parseFloat(button.style.aspectRatio)).toBeCloseTo(1600 / 900, 3);
    });
  });

  it("marks only the first slide as the cover", () => {
    const props = getDefaultProps({
      photos: [createMockPhoto("p1"), createMockPhoto("p2"), createMockPhoto("p3")],
    });
    render(<ReportMediaPicker {...props} />);

    const all = slides();
    expect(within(all[0]!).getByTestId("report-photo-cover-badge").textContent).toBe("Cover");
    expect(within(all[1]!).queryByTestId("report-photo-cover-badge")).toBeNull();
    expect(within(all[2]!).queryByTestId("report-photo-cover-badge")).toBeNull();
  });

  it("tap on a slide opens the full preview at that photo", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
    render(<ReportMediaPicker {...props} />);

    tap(slideButtons()[1]!);
    expect(props.onPreview).toHaveBeenCalledWith("p2", { x: 0, y: 0, width: 0, height: 0 });
  });

  it("keyboard activation opens the preview even after a gesture left a press behind", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
    render(<ReportMediaPicker {...props} />);

    // A swipe fires no trailing click in some browsers, so its press origin is
    // still recorded when the next activation arrives. Enter/Space on the slide
    // is that activation: a click at the origin with no pointer behind it
    // (detail 0). Judging it by the stale geometry would reject it and leave the
    // viewer unreachable without a pointer.
    fireEvent.touchStart(slideButtons()[1]!, { touches: [{ clientX: 260, clientY: 40 }] });
    fireEvent.click(slideButtons()[1]!, { clientX: 0, clientY: 0, detail: 0 });

    expect(props.onPreview).toHaveBeenCalledWith("p2", { x: 0, y: 0, width: 0, height: 0 });
  });

  it("names the cover in the first slide's accessible name", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
    render(<ReportMediaPicker {...props} />);

    // The badge is visible; a screen-reader user gets the same fact from the
    // slide's name (the aria-label replaces the inner text).
    expect(screen.getByRole("button", { name: /view photo 1 of 2 full size \(cover\)/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /view photo 2 of 2 full size$/i })).toBeTruthy();
  });

  it("keeps the active photo, not the index, when the order changes", () => {
    // The action row acts on the active photo, so a reorder that left the index
    // alone would silently re-aim it: the person taps "Move right" on photo 2
    // and the next tap lands on a different photo.
    const props = getDefaultProps({
      photos: [createMockPhoto("p1"), createMockPhoto("p2"), createMockPhoto("p3")],
    });
    const view = render(<ReportMediaPicker {...props} />);

    goToPhoto(2);
    expect(screen.getByRole("button", { name: "Remove photo 2" })).toBeTruthy();

    // The parent applies the move and hands back the reordered array.
    view.rerender(
      <ReportMediaPicker
        {...props}
        photos={[createMockPhoto("p1"), createMockPhoto("p3"), createMockPhoto("p2")]}
      />,
    );

    // Photo 2 is now last, and the row followed it there.
    expect(screen.getByRole("button", { name: "Remove photo 3" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Move photo 3 right" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a swipe pages without opening the preview", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
    render(<ReportMediaPicker {...props} />);

    // Press left, release 40px away: a page gesture, never an open.
    fireEvent.mouseDown(slideButtons()[0]!, { clientX: 100, clientY: 40 });
    fireEvent.click(slideButtons()[0]!, { clientX: 140, clientY: 40 });
    expect(props.onPreview).not.toHaveBeenCalled();
  });

  it("the action row always acts on the active photo", () => {
    const props = getDefaultProps({
      photos: [createMockPhoto("p1"), createMockPhoto("p2"), createMockPhoto("p3")],
    });
    render(<ReportMediaPicker {...props} />);

    // First photo: cannot move left, can move right, is already the cover.
    expect((screen.getByRole("button", { name: "Move photo 1 left" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move photo 1 right" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Make photo 1 the cover" })).toBeNull();

    goToPhoto(2);

    expect(screen.queryByRole("button", { name: "Move photo 1 left" })).toBeNull();
    expect((screen.getByRole("button", { name: "Move photo 2 left" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Move photo 2 right" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Make photo 2 the cover" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove photo 2" })).toBeTruthy();

    goToPhoto(3);

    expect((screen.getByRole("button", { name: "Move photo 3 left" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Move photo 3 right" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("moves one photo to the front when asked to make it the cover", () => {
    const props = getDefaultProps({
      photos: [createMockPhoto("p1"), createMockPhoto("p2"), createMockPhoto("p3")],
    });
    render(<ReportMediaPicker {...props} />);

    goToPhoto(3);
    fireEvent.click(screen.getByRole("button", { name: "Make photo 3 the cover" }));
    expect(props.onMakeCover).toHaveBeenCalledWith("p3");
    expect(props.onMakeCover).toHaveBeenCalledTimes(1);
  });

  it("a single photo keeps its remove action and offers no pager or reorder controls", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1")] });
    render(<ReportMediaPicker {...props} />);

    expect(screen.queryByTestId("report-photo-dots")).toBeNull();
    expect(screen.queryByTestId("report-photo-position")).toBeNull();
    expect(screen.queryByRole("button", { name: "Make photo 1 the cover" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move photo 1 left" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move photo 1 right" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove photo 1" })).toBeTruthy();
  });

  it("empty state asks for photos and renders no track", () => {
    const props = getDefaultProps();
    render(<ReportMediaPicker {...props} />);

    expect(screen.queryByTestId("report-photo-carousel")).toBeNull();
    expect(screen.getByText("Add up to 5 photos. The first photo is the cover.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Take photo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose up to 5 photos" })).toBeTruthy();
  });

  it("keeps every selected photo in one horizontal track at 320dp", () => {
    const original = window.matchMedia;
    const stub = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
    Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: vi.fn(stub) });
    try {
      const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
      render(<ReportMediaPicker {...props} />);

      // One track, one row: the narrow layout must not stack the photos into a
      // vertical column of tiles.
      const tracks = screen.getAllByTestId("report-photo-track");
      expect(tracks).toHaveLength(1);
      expect(tracks[0]!.className).toContain("overflow-x-auto");
      expect(slides()).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Take photo" })).toBeTruthy();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: original });
    }
  });

  it("pops a newly added slide in from the shared enter scale", async () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1")] });
    const { rerender } = render(<ReportMediaPicker {...props} />);
    expect(slides()).toHaveLength(1);

    rerender(<ReportMediaPicker {...getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] })} />);

    const added = slides()[1]!;
    expect(added.style.opacity).toBe("0");
    await waitFor(
      () => {
        expect(added.style.opacity).toBe("1");
      },
      { timeout: 3000 },
    );
  });

  it("keeps a removed slide mounted through its exit before it disappears", async () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
    const { rerender } = render(<ReportMediaPicker {...props} />);

    rerender(<ReportMediaPicker {...getDefaultProps({ photos: [createMockPhoto("p1")] })} />);
    // Still exiting: both slides are present for a moment.
    expect(slides()).toHaveLength(2);

    await waitFor(
      () => {
        expect(slides()).toHaveLength(1);
      },
      { timeout: 3000 },
    );
  });

  it("acknowledges a camera press with the shared press scale", async () => {
    const props = getDefaultProps();
    render(<ReportMediaPicker {...props} />);
    const cameraBtn = screen.getByRole("button", { name: "Take photo" });

    fireEvent.pointerDown(cameraBtn, { pointerId: 1, isPrimary: true, buttons: 1 });
    await waitFor(
      () => {
        expect(cameraBtn.style.transform).toContain("scale(0.96");
      },
      { timeout: 2000 },
    );

    fireEvent.pointerUp(cameraBtn, { pointerId: 1, isPrimary: true, buttons: 0 });
    await waitFor(
      () => {
        expect(
          cameraBtn.style.transform === "" || cameraBtn.style.transform === "none",
        ).toBe(true);
      },
      { timeout: 2000 },
    );
  });

  it("shows motion disclosure only for flagged motion photos, regardless of format", () => {
    const props = getDefaultProps({ photos: [{ ...createMockPhoto("p1", "jpg"), motionPhoto: true }, createMockPhoto("p2", "heic")] });
    render(<ReportMediaPicker {...props} />);
    expect(screen.getByText("Motion photo: still image will be posted; motion clip is not included")).toBeTruthy();
  });

  it("does not show motion disclosure for unflagged HEIC photos", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1", "heic"), createMockPhoto("p2", "png")] });
    render(<ReportMediaPicker {...props} />);
    expect(screen.queryByText("Motion photo: still image will be posted; motion clip is not included")).toBeNull();
  });

  it("calls onAddCamera when camera button clicked", () => {
    const props = getDefaultProps();
    render(<ReportMediaPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Take photo" }));
    expect(props.onAddCamera).toHaveBeenCalledTimes(1);
  });

  it("calls onAddGallery with remaining when gallery button clicked", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
    render(<ReportMediaPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose up to 3 photos" }));
    expect(props.onAddGallery).toHaveBeenCalledWith(3);
  });

  it("calls onRemove with the active photo's id", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
    render(<ReportMediaPicker {...props} />);
    goToPhoto(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo 2" }));
    expect(props.onRemove).toHaveBeenCalledWith("p2");
  });

  it("calls onMove with the active photo's id and direction", () => {
    const props = getDefaultProps({
      photos: [createMockPhoto("p1"), createMockPhoto("p2"), createMockPhoto("p3")],
    });
    render(<ReportMediaPicker {...props} />);
    goToPhoto(2);
    fireEvent.click(screen.getByRole("button", { name: "Move photo 2 left" }));
    expect(props.onMove).toHaveBeenCalledWith("p2", "earlier");
    fireEvent.click(screen.getByRole("button", { name: "Move photo 2 right" }));
    expect(props.onMove).toHaveBeenCalledWith("p2", "later");
  });

  it("does not call handlers when disabled", () => {
    const props = getDefaultProps({
      disabled: true,
      photos: [createMockPhoto("p1"), createMockPhoto("p2")],
    });
    render(<ReportMediaPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Take photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove photo 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Move photo 1 right" }));
    expect(props.onAddCamera).not.toHaveBeenCalled();
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(props.onMove).not.toHaveBeenCalled();
  });

  it("shows limit notice at 5/5", () => {
    const photos = Array.from({ length: 5 }, (_, i) => createMockPhoto(`p${i}`));
    const props = getDefaultProps({ photos });
    render(<ReportMediaPicker {...props} />);
    expect(screen.getByText("Maximum of 5 photos reached")).toBeTruthy();
  });

  it("does not show limit notice below 5", () => {
    const photos = Array.from({ length: 4 }, (_, i) => createMockPhoto(`p${i}`));
    const props = getDefaultProps({ photos });
    render(<ReportMediaPicker {...props} />);
    expect(screen.queryByText("Maximum of 5 photos reached")).toBeNull();
  });

  it("keys slides by photo id so a reorder never rebuilds the list", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("stable-id-1"), createMockPhoto("stable-id-2")] });
    render(<ReportMediaPicker {...props} />);
    expect(slides().map((slide) => slide.getAttribute("data-photo-id"))).toEqual([
      "stable-id-1",
      "stable-id-2",
    ]);
  });

  it("does not import CreateReport", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    const source = fs.readFileSync(path.resolve(__dirname, "./ReportMediaPicker.tsx"), "utf-8");
    expect(source).not.toContain("CreateReport");
  });
});
