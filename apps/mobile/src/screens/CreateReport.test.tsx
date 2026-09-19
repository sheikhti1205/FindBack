// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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
  Plugins: { ShortLinkResolver: { resolve: vi.fn() } },
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

  it("keeps the photo uploadable across navigation (draft restore)", async () => {    publishReportMock.mockResolvedValue("p1");
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

  it("surfaces a friendly error when native capture fails (WP13 #17)", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.takePhoto.mockRejectedValue(new Error("camera busy"));
    try {
      render(<CreateReport />);
      fireEvent.click(await screen.findByRole("button", { name: /take photo/i }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/camera busy/i);
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      photo.takePhoto.mockReset();
    }
  });

  it("requires a date before publishing (WP13 #18)", async () => {
    publishReportMock.mockResolvedValue("p1");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: "a black phone lost near the library" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "" } });
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/choose a date/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects non-image files before upload (WP13 #19)", async () => {
    render(<CreateReport />);
    pickFile(new File(["abc"], "notes.txt", { type: "text/plain" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/image/i);
    expect(screen.queryByRole("button", { name: /remove photo/i })).toBeNull();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects oversized images before upload (WP13 #19)", async () => {
    render(<CreateReport />);
    const big = new File([new Uint8Array(9 * 1024 * 1024)], "big.jpg", { type: "image/jpeg" });
    pickFile(big);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/too large|8 mb/i);
    expect(screen.queryByRole("button", { name: /remove photo/i })).toBeNull();
  });

  it("warns when the link is not a YouTube URL (WP13 #36)", async () => {
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/youtube link/i), { target: { value: "https://example.com/video" } });
    expect(await screen.findByText(/doesn't look like a youtube link/i)).toBeTruthy();
  });

  // Validation alignment tests (W6 #17)
  it("rejects title shorter than 3 characters", async () => {
    publishReportMock.mockResolvedValue("p1");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Ab" } });
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: "a black phone lost near the library" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/title must be at least 3 characters/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects title longer than 120 characters", async () => {
    publishReportMock.mockResolvedValue("p1");
    render(<CreateReport />);
    const longTitle = "A".repeat(121);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: longTitle } });
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: "a black phone lost near the library" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/title must be at most 120 characters/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects description shorter than 10 characters", async () => {
    publishReportMock.mockResolvedValue("p1");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/description must be at least 10 characters/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects description longer than 3000 characters", async () => {
    publishReportMock.mockResolvedValue("p1");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    const longDesc = "A".repeat(3001);
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: longDesc } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/description must be at most 3000 characters/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects location label longer than 200 characters", async () => {
    publishReportMock.mockResolvedValue("p1");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: "a black phone lost near the library" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
    const longLocation = "A".repeat(201);
    const locationInput = screen.getByLabelText(/approximate location/i) as HTMLInputElement;
    fireEvent.change(locationInput, { target: { value: longLocation } });
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/location label is too long/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects invalid YouTube URLs (non-YouTube hosts)", async () => {
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/youtube link/i), { target: { value: "https://vimeo.com/123456" } });
    expect(await screen.findByText(/doesn't look like a youtube link/i)).toBeTruthy();
  });

  it("accepts valid YouTube URL formats", async () => {
    render(<CreateReport />);
    const validUrls = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    ];
    for (const url of validUrls) {
      fireEvent.change(screen.getByLabelText(/youtube link/i), { target: { value: url } });
      expect(screen.queryByText(/doesn't look like a youtube link/i)).toBeNull();
    }
  });

  it("rejects invalid calendar dates when set programmatically (e.g., from draft)", async () => {
    publishReportMock.mockResolvedValue("p1");
    // Save a draft with an invalid date
    const { saveDraft } = await import("../services/reportDraft");
    saveDraft({
      type: "LOST",
      title: "Lost phone",
      description: "a black phone lost near the library",
      category: "Electronics",
      eventDate: "2026-02-30", // Invalid date
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    });
    render(<CreateReport />);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/choose a valid date/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  // Blob lifecycle tests (W6 #16)
  it("revokes blob URL on unmount but keeps stashed File", async () => {
    const { unmount } = render(<CreateReport />);
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));
    await screen.findByRole("button", { name: /remove photo/i });
    expect(URL.createObjectURL).toHaveBeenCalled();

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalled();

    // Remount should recreate blob URL from stashed File
    render(<CreateReport />);
    expect(screen.getByRole("img", { name: /attachment preview/i })).toBeTruthy();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("replaces photo: revokes old blob and removes old stashed File", async () => {
    render(<CreateReport />);
    pickFile(new File(["abc"], "p1.jpg", { type: "image/jpeg" }));
    await screen.findByRole("button", { name: /remove photo/i });
    const firstRevokeCount = (URL.revokeObjectURL as Mock).mock.calls.length;

    // Remove the first photo, then pick a new one
    fireEvent.click(screen.getByRole("button", { name: /remove photo/i }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /remove photo/i })).toBeNull());

    pickFile(new File(["def"], "p2.jpg", { type: "image/jpeg" }));
    await screen.findByRole("button", { name: /remove photo/i });

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(firstRevokeCount + 1);
  });

  it("discard draft: revokes blob and removes stashed File", async () => {
    render(<CreateReport />);
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));
    await screen.findByRole("button", { name: /remove photo/i });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      fireEvent.click(screen.getByRole("button", { name: /discard draft/i }));
      await waitFor(() => expect(screen.queryByRole("button", { name: /remove photo/i })).toBeNull());
    } finally {
      confirmSpy.mockRestore();
    }

    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("publish: revokes blob and removes stashed File", async () => {
    publishReportMock.mockResolvedValue("p1");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    fireEvent.change(screen.getByPlaceholderText(/colour, brand, markings/i), { target: { value: "a black phone lost near the library" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "Electronics" } });
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));
    await screen.findByRole("button", { name: /remove photo/i });

    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() => expect(publishReportMock).toHaveBeenCalled());

    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});
