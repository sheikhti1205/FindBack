// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishReportMock, photo } = vi.hoisted(() => ({
  publishReportMock: vi.fn(),
  photo: {
    isNativeCameraAvailable: vi.fn(() => false),
    takePhoto: vi.fn(),
    chooseFromGallery: vi.fn(),
    photoToFile: vi.fn(),
    toNativeImageUri: vi.fn(),
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../services/posts", () => ({ publishReport: publishReportMock }));
vi.mock("../services/photo", () => photo);

import { CreateReport } from "./CreateReport";
import { clearDraft } from "../services/reportDraft";
import { clearPhotoStore } from "../services/photoStore";

function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  publishReportMock.mockReset();
  clearDraft();
  clearPhotoStore();
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:preview");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  clearDraft();
  clearPhotoStore();
});

describe("CreateReport", () => {
  it("does not offer the generic file picker on native, so all capture paths reach the VLM (WP13)", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    try {
      render(<CreateReport />);
      const takePhotoBtn = await screen.findByRole("button", { name: /take photo/i });
      expect(takePhotoBtn).toBeTruthy();
      expect(screen.getByRole("button", { name: /choose from gallery/i })).toBeTruthy();
      expect(document.querySelector('input[type="file"]')).toBeNull();
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
    }
  });

  it("resets the location picker UI when the draft is discarded (WP9)", async () => {
    render(<CreateReport />);
    const locationInput = screen.getByLabelText(/approximate location/i) as HTMLInputElement;
    fireEvent.change(locationInput, { target: { value: "23.810332, 90.412518" } });
    expect(locationInput.value).toBe("23.810332, 90.412518");

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      fireEvent.click(screen.getByRole("button", { name: /discard draft/i }));
      await waitFor(() => expect(locationInput.value).toBe(""));
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("keeps an exact pin (with its warning) across navigation (WP9)", async () => {
    const { unmount } = render(<CreateReport />);
    const locationInput = screen.getByLabelText(/approximate location/i);
    fireEvent.change(locationInput, { target: { value: "23.810332, 90.412518" } });
    fireEvent.click(await screen.findByRole("button", { name: /use exact pin/i }));
    await screen.findByText(/exact pin and will be shown publicly/i);

    unmount();
    render(<CreateReport />);
    expect(await screen.findByText(/exact pin and will be shown publicly/i)).toBeTruthy();
  });

  it("clears the selected file and preview when the photo is removed", async () => {
    render(<CreateReport />);
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));

    await screen.findByRole("button", { name: /remove photo/i });

    fireEvent.click(screen.getByRole("button", { name: /remove photo/i }));

    expect(screen.queryByRole("button", { name: /remove photo/i })).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("does not upload when a photo is selected", async () => {
    render(<CreateReport />);
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));
    await screen.findByRole("button", { name: /remove photo/i });
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("publishes with the selected photo on submit", async () => {
    publishReportMock.mockResolvedValue("p1");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: "a black phone lost near the library" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
    const file = new File(["abc"], "p.jpg", { type: "image/jpeg" });
    pickFile(file);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() => expect(publishReportMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Lost phone" }), file));
  });

  it("keeps the selected photo when publish fails", async () => {
    publishReportMock.mockRejectedValue(new Error("Could not publish"));
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: "a black phone lost near the library" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await screen.findByText(/could not publish/i);
    expect(screen.getByRole("img", { name: /attachment preview/i })).toBeTruthy();
  });

  it("allows manual category selection without AI", async () => {
    publishReportMock.mockResolvedValue("p1");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost keys" } });
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: "house keys on a blue lanyard" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Keys" } });
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() => expect(publishReportMock).toHaveBeenCalledWith(expect.objectContaining({ category: "Keys" }), null));
  });

  it("keeps the photo uploadable across navigation (draft restore)", async () => {
    publishReportMock.mockResolvedValue("p1");
    const { unmount } = render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: "a black phone lost near the library" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
    const file = new File(["abc"], "p.jpg", { type: "image/jpeg" });
    pickFile(file);
    await screen.findByRole("button", { name: /remove photo/i });

    // Simulate leaving to Offline AI and coming back.
    unmount();
    render(<CreateReport />);
    expect(screen.getByRole("img", { name: /attachment preview/i })).toBeTruthy();

    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() =>
      expect(publishReportMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Lost phone" }),
        expect.any(File),
      ),
    );
  });
});
