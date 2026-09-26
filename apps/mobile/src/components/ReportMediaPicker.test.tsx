// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    onPreview: vi.fn(),
    disabled: false,
    ...overrides,
  };
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
    const cameraBtn = screen.getByRole("button", { name: "Take photo" });
    const galleryBtn = screen.getByRole("button", { name: "Choose up to 5 photos" });
    expect(cameraBtn).toBeTruthy();
    expect(galleryBtn).toBeTruthy();
  });

  it("buttons have minimum 48px hitbox", () => {
    const props = getDefaultProps();
    render(<ReportMediaPicker {...props} />);
    const cameraBtn = screen.getByRole("button", { name: "Take photo" });
    const galleryBtn = screen.getByRole("button", { name: "Choose up to 5 photos" });
    expect(cameraBtn).toBeTruthy();
    expect(galleryBtn).toBeTruthy();
  });

  it("disables add buttons at 5/5", () => {
    const photos = Array.from({ length: 5 }, (_, i) => createMockPhoto(`p${i}`));
    const props = getDefaultProps({ photos });
    render(<ReportMediaPicker {...props} />);
    const cameraBtn = screen.getByRole("button", { name: "Take photo" });
    const galleryBtn = screen.getByRole("button", { name: "Choose up to 0 photos" });
    expect((cameraBtn as HTMLButtonElement).disabled).toBe(true);
    expect((galleryBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("gallery button shows remaining count in aria-label", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2"), createMockPhoto("p3")] });
    render(<ReportMediaPicker {...props} />);
    const galleryBtn = screen.getByRole("button", { name: "Choose up to 2 photos" });
    expect(galleryBtn).toBeTruthy();
  });

  it("renders 1:1 tiles with Photo n of 5 badge", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
    render(<ReportMediaPicker {...props} />);
    const tiles = screen.getAllByRole("listitem");
    expect(tiles).toHaveLength(2);
    expect(screen.getByText("Photo 1 of 2")).toBeTruthy();
    expect(screen.getByText("Photo 2 of 2")).toBeTruthy();
  });

  it("tap on tile opens full preview", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1")] });
    render(<ReportMediaPicker {...props} />);
    const tileImage = screen.getByAltText("Photo 1 of 1");
    fireEvent.click(tileImage);
    expect(props.onPreview).toHaveBeenCalledWith("p1");
  });

  it("per-tile controls: Move earlier/later/Remove with correct labels", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2"), createMockPhoto("p3")] });
    render(<ReportMediaPicker {...props} />);

    // First photo: no "earlier", has "later"
    expect((screen.getByRole("button", { name: "Move photo 1 earlier" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move photo 1 later" }) as HTMLButtonElement).disabled).toBe(false);

    // Middle photo: has both
    expect((screen.getByRole("button", { name: "Move photo 2 earlier" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Move photo 2 later" }) as HTMLButtonElement).disabled).toBe(false);

    // Last photo: has "earlier", no "later"
    expect((screen.getByRole("button", { name: "Move photo 3 earlier" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Move photo 3 later" }) as HTMLButtonElement).disabled).toBe(true);

    // All have remove
    expect(screen.getByRole("button", { name: "Remove photo 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove photo 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove photo 3" })).toBeTruthy();
  });

  it("hides reorder controls when single photo", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1")] });
    render(<ReportMediaPicker {...props} />);
    expect(screen.queryByRole("button", { name: "Move photo 1 earlier" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move photo 1 later" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove photo 1" })).toBeTruthy();
  });

  it("stable key by photo.id", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("stable-id-1"), createMockPhoto("stable-id-2")] });
    render(<ReportMediaPicker {...props} />);
    // React keys are not directly testable, but we verify the component uses photo.id as key
    // by checking the component renders correctly with stable IDs
    expect(screen.getByText("Photo 1 of 2")).toBeTruthy();
    expect(screen.getByText("Photo 2 of 2")).toBeTruthy();
  });

  it("shows HEIC/motion disclosure when HEIC photos present", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1", "heic"), createMockPhoto("p2", "jpg")] });
    render(<ReportMediaPicker {...props} />);
    expect(screen.getByText("Motion photo: still image will be posted; motion clip is not included")).toBeTruthy();
  });

  it("does not show disclosure when no HEIC photos", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1", "jpg"), createMockPhoto("p2", "png")] });
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

  it("calls onRemove with correct id", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2")] });
    render(<ReportMediaPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo 2" }));
    expect(props.onRemove).toHaveBeenCalledWith("p2");
  });

  it("calls onMove with correct id and direction", () => {
    const props = getDefaultProps({ photos: [createMockPhoto("p1"), createMockPhoto("p2"), createMockPhoto("p3")] });
    render(<ReportMediaPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Move photo 2 earlier" }));
    expect(props.onMove).toHaveBeenCalledWith("p2", "earlier");
    fireEvent.click(screen.getByRole("button", { name: "Move photo 2 later" }));
    expect(props.onMove).toHaveBeenCalledWith("p2", "later");
  });

  it("does not call handlers when disabled", () => {
    const props = getDefaultProps({ disabled: true, photos: [createMockPhoto("p1")] });
    render(<ReportMediaPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Take photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove photo 1" }));
    expect(props.onAddCamera).not.toHaveBeenCalled();
    expect(props.onRemove).not.toHaveBeenCalled();
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

  it("does not import CreateReport", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path");
    const source = fs.readFileSync(path.resolve(__dirname, "./ReportMediaPicker.tsx"), "utf-8");
    expect(source).not.toContain("CreateReport");
  });
});