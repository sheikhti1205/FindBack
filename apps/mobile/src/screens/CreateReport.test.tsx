// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const { publishReportMock, publishReportWithPhotosMock, photo } = vi.hoisted(() => ({
  publishReportMock: vi.fn(),
  publishReportWithPhotosMock: vi.fn(),
  photo: {
    isNativeCameraAvailable: vi.fn(() => false),
    takePhoto: vi.fn(),
    chooseFromGallery: vi.fn(),
    chooseReportPhotos: vi.fn(),
    photoToFile: vi.fn(),
    // Production normalizeForUpload enforces the 8 MB upload limit against
    // the derivative (or the original when no decoder exists, as here): the
    // mock mirrors that fallback edge so the rejection path stays covered.
    // The normalize-first acceptance path is unit-tested in photo.test.ts.
    normalizeForUpload: vi.fn(async (file: File) => {
      if (file.size > 8 * 1024 * 1024) throw new Error("That photo is too large. Choose an image under 8 MB.");
      return file;
    }),
    toNativeImageUri: vi.fn(),
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  Plugins: { ShortLinkResolver: { resolve: vi.fn() } },
}));
vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../services/posts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/posts")>();
  return {
    ...actual,
    publishReport: (...args: unknown[]) => publishReportMock(...args),
    publishReportWithPhotos: (...args: unknown[]) => publishReportWithPhotosMock(...args),
  };
});
vi.mock("../services/photo", () => photo);

import { CreateReport } from "./CreateReport";
import { clearDraft, saveDraft } from "../services/reportDraft";
import { clearPhotoStore, stashPhotoFile } from "../services/photoStore";
import { loadDraft } from "../services/reportDraft";
import { todayInputValue } from "../utils/dates";
import * as photoStore from "../services/photoStore";

import { chooseCategory } from "../test-utils/reportCategory";
function seedDescription(description: string): void {
  saveDraft({
    type: "LOST",
    title: "",
    description,
    category: "",
    eventDate: todayInputValue(),
    location: { label: "", latitude: null, longitude: null },
    youtubeUrl: "",
    photoId: null,
    photoNativeUri: null,
    photoWebPath: null,
    photoFormat: null,
  }, "u1");
}

function pickFile(file: File) {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error("file input not found");
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  publishReportMock.mockReset();
  publishReportWithPhotosMock.mockReset();
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
  it("does not offer the generic file picker on native, so all capture paths reach the VLM", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    try {
      render(<CreateReport />);
      const takePhotoBtn = await screen.findByRole("button", { name: /take photo/i });
      expect(takePhotoBtn).toBeTruthy();
      expect(screen.getByRole("button", { name: /choose up to \d+ photos/i })).toBeTruthy();
      expect(document.querySelector('input[type="file"]')).toBeNull();
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
    }
  });

  it("resets the location picker UI when the draft is discarded", async () => {
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

  it("keeps an exact pin (with its warning) across navigation", async () => {
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

  it("keeps a selected photo visible and warns when draft-byte storage fails", async () => {
    const persist = vi.spyOn(photoStore, "persistStashedPhotos").mockRejectedValue(new Error("quota"));
    try {
      render(<CreateReport />);
      pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));
      await screen.findByRole("button", { name: /remove photo/i });
      await screen.findByText(/photos could not be saved for draft recovery/i);
      expect(screen.getByRole("img", { name: /photo 1 of/i })).toBeTruthy();
    } finally {
      persist.mockRestore();
    }
  });

  it("shows Saving photos until the retry's durable write confirms", async () => {
    // Every persist fails until the retry is armed: the warning is then
    // deterministic regardless of how many mount-time writes occur. The retry
    // holds its write open so the test can observe the in-flight status: the
    // warning must NOT clear on press — only "Saving photos…" shows — and it
    // clears only after the durable write confirms.
    let fail = true;
    let release: ((report: { durable: boolean; warning: null }) => void) | null = null;
    const persist = vi.spyOn(photoStore, "persistStashedPhotos").mockImplementation(() => {
      if (fail) return Promise.reject(new Error("quota"));
      return new Promise((resolve) => { release = resolve; });
    });
    try {
      render(<CreateReport />);
      pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));
      await screen.findByRole("button", { name: /retry saving photos/i });
      const beforeRetry = persist.mock.calls.length;
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: /retry saving photos/i }));
      // In flight: saving status shows, the failure warning stays hidden, and
      // the session photo is untouched — nothing was cleared optimistically.
      await screen.findByText(/saving photos/i);
      expect(screen.queryByText(/photos could not be saved/i)).toBeNull();
      expect(screen.getByRole("button", { name: /remove photo/i })).toBeTruthy();
      // The retry wrote the same photo set again without reselecting.
      expect(persist.mock.calls.length).toBe(beforeRetry + 1);
      release!({ durable: true, warning: null });
      await waitFor(() => expect(screen.queryByText(/saving photos/i)).toBeNull());
      expect(screen.queryByText(/photos could not be saved/i)).toBeNull();
    } finally {
      persist.mockRestore();
    }
  });

  it("publishes with the selected photo on submit", async () => {
    publishReportMock.mockResolvedValue("p1");
    seedDescription("a black phone lost near the library");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    await chooseCategory("Electronics");
    const file = new File(["abc"], "p.jpg", { type: "image/jpeg" });
    pickFile(file);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() => expect(publishReportMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Lost phone" }), file, expect.any(String)));
  });

  it("keeps the selected photo when publish fails", async () => {
    publishReportMock.mockRejectedValue(new Error("Could not publish"));
    seedDescription("a black phone lost near the library");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    await chooseCategory("Electronics");
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await screen.findByText(/could not publish/i);
    expect(screen.getByRole("img", { name: /photo 1 of/i })).toBeTruthy();
  });

  it("blocks publishing while saved photo bytes are still being recovered", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<string[]>((resolve) => { finishRecovery = () => resolve([]); });
    const restore = vi.spyOn(photoStore, "restoreStashedPhotos").mockReturnValue(recovery);
    seedDescription("a black phone lost near the library");
    saveDraft({ ...loadDraft("u1")!, title: "Lost phone", category: "Electronics", photoId: "pending", photoIds: ["pending"] }, "u1");
    try {
      render(<CreateReport />);
      expect((screen.getByRole("button", { name: /publish/i }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
      expect(publishReportMock).not.toHaveBeenCalled();
    } finally {
      finishRecovery();
      restore.mockRestore();
    }
  });

  it("keeps draft photo references and blocks publish when recovery fails", async () => {
    const restore = vi.spyOn(photoStore, "restoreStashedPhotos").mockRejectedValue(new Error("IDB unavailable"));
    seedDescription("a black phone lost near the library");
    saveDraft({ ...loadDraft("u1")!, title: "Lost phone", category: "Electronics", photoId: "pending", photoIds: ["pending"] }, "u1");
    try {
      render(<CreateReport />);
      await screen.findByText(/saved photos could not be recovered/i);
      expect(loadDraft("u1")?.photoIds).toEqual(["pending"]);
      expect((screen.getByRole("button", { name: /publish/i }) as HTMLButtonElement).disabled).toBe(true);
      expect(publishReportMock).not.toHaveBeenCalled();
    } finally {
      restore.mockRestore();
    }
  });

  it("does not silently publish a draft whose saved photo bytes are missing", async () => {
    seedDescription("a black phone lost near the library");
    saveDraft({ ...loadDraft("u1")!, title: "Lost phone", category: "Electronics", photoId: "missing", photoIds: ["missing"] }, "u1");
    render(<CreateReport />);
    await screen.findByText(/saved photos could not be recovered/i);
    expect(loadDraft("u1")?.photoIds).toEqual(["missing"]);
    expect((screen.getByRole("button", { name: /publish/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the failed slot and recovers it on retry", async () => {
    seedDescription("a black phone lost near the library");
    saveDraft({
      ...loadDraft("u1")!,
      title: "Lost phone",
      category: "Electronics",
      photoId: "r1",
      photoIds: ["r1"],
      photoRefs: [{ id: "r1", nativeUri: "content://photo", webPath: "content://photo", format: "jpg" }],
    }, "u1");
    const converted = new File(["jpeg-bytes"], "photo.jpg", { type: "image/jpeg" });
    photo.photoToFile.mockRejectedValueOnce(new Error("revive failed"));
    photo.photoToFile.mockResolvedValueOnce(converted);
    try {
      render(<CreateReport />);
      // The failure names the slot instead of a bare boolean.
      await screen.findByText(/could not be recovered.*photo 1/i);
      expect((screen.getByRole("button", { name: /publish/i }) as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: /retry recovery/i }));
      await waitFor(() =>
        expect((screen.getByRole("button", { name: /publish/i }) as HTMLButtonElement).disabled).toBe(false),
      );
      expect(screen.queryByText(/could not be recovered/i)).toBeNull();
      expect(screen.getByRole("img", { name: /photo 1 of/i })).toBeTruthy();
    } finally {
      photo.photoToFile.mockReset();
    }
  });

  it("removes unavailable photos with confirmation and keeps the draft text", async () => {
    seedDescription("a black phone lost near the library");
    saveDraft({
      ...loadDraft("u1")!,
      title: "Lost phone",
      category: "Electronics",
      photoId: "gone",
      photoIds: ["gone"],
    }, "u1");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      render(<CreateReport />);
      await screen.findByText(/could not be recovered.*photo 1/i);

      fireEvent.click(screen.getByRole("button", { name: /remove unavailable and continue/i }));
      expect(confirmSpy).toHaveBeenCalled();
      await waitFor(() =>
        expect((screen.getByRole("button", { name: /publish/i }) as HTMLButtonElement).disabled).toBe(false),
      );
      // Pruned from the persisted draft; the text survives for the new attempt.
      await waitFor(() => expect(loadDraft("u1")?.photoIds).toEqual([]));
      expect(loadDraft("u1")?.title).toBe("Lost phone");
      expect(screen.queryByText(/could not be recovered/i)).toBeNull();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("keeps mixed-success conversions when the middle photo fails, then publishes the survivors", async () => {
    publishReportWithPhotosMock.mockResolvedValue("p3");
    saveDraft({
      type: "LOST",
      title: "Lost camera",
      description: "a black camera lost near the library entrance",
      category: "Cameras & Photography",
      eventDate: todayInputValue(),
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: "p1",
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
      photoIds: ["p1", "p2", "p3"],
      photoRefs: [
        { id: "p1", nativeUri: "content://p1", webPath: "content://p1", format: "jpg" },
        { id: "p2", nativeUri: "content://p2", webPath: "content://p2", format: "jpg" },
        { id: "p3", nativeUri: "content://p3", webPath: "content://p3", format: "jpg" },
      ],
    }, "u1");
    photo.photoToFile.mockImplementation((picked: { nativeUri: string }) => {
      if (picked.nativeUri === "content://p2") return Promise.reject(new Error("revive failed"));
      const tag = picked.nativeUri === "content://p1" ? "one" : "three";
      return Promise.resolve(new File([`${tag}-bytes`], `${tag}.jpg`, { type: "image/jpeg" }));
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      render(<CreateReport />);
      // Only the middle slot failed — and it is named, not a bare boolean.
      await screen.findByText(/could not be recovered.*photo 2/i);
      // The successful conversions are already committed, not dropped.
      expect(screen.getByRole("img", { name: /photo 1 of 2/i })).toBeTruthy();
      expect(screen.getByRole("img", { name: /photo 2 of 2/i })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /remove unavailable and continue/i }));
      expect(confirmSpy).toHaveBeenCalled();
      await waitFor(() =>
        expect((screen.getByRole("button", { name: /publish/i }) as HTMLButtonElement).disabled).toBe(false),
      );
      // Survivors keep original ids and draft order; the failed slot is pruned.
      await waitFor(() => expect(loadDraft("u1")?.photoIds).toEqual(["p1", "p3"]));

      fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
      await waitFor(() => expect(publishReportWithPhotosMock).toHaveBeenCalled());
      const files = publishReportWithPhotosMock.mock.calls[0]![1] as File[];
      expect(files).toHaveLength(2);
      expect(await files[0]!.text()).toBe("one-bytes");
      expect(await files[1]!.text()).toBe("three-bytes");
    } finally {
      confirmSpy.mockRestore();
      photo.photoToFile.mockReset();
    }
  });

  it("photo-only draft with an unavailable photo can still be discarded", async () => {
    saveDraft({
      type: "LOST",
      title: "",
      description: "",
      category: "",
      eventDate: todayInputValue(),
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: "gone",
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
      photoIds: ["gone"],
    }, "u1");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      render(<CreateReport />);
      await screen.findByText(/could not be recovered/i);
      // No text at all: the old guard returned early and wedged the screen.
      fireEvent.click(screen.getByRole("button", { name: /discard draft/i }));
      expect(confirmSpy).toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByText(/could not be recovered/i)).toBeNull());
      // The unavailable slot is gone; only the (pre-existing) empty draft
      // shell remains, which loads as a blank form.
      expect(loadDraft("u1")?.photoIds).toEqual([]);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("a later unreadable web file never starves a valid one behind it", async () => {
    seedDescription("a black phone lost near the library");
    render(<CreateReport />);
    const bad = new File(["nope"], "notes.txt", { type: "text/plain" });
    const good = new File([new Uint8Array([255, 216, 255, 217])], "ok.jpg", { type: "image/jpeg" });
    const input = document.querySelector('input[type="file"]');
    if (!input) throw new Error("file input not found");
    fireEvent.change(input, { target: { files: [bad, good] } });
    // Sequential validation: the valid JPEG is accepted despite the bad first file.
    await screen.findByRole("img", { name: /photo 1 of 1/i });
    expect(screen.getByText(/unreadable/i)).toBeTruthy();
  });

  it("names each failed web file with its own reason", async () => {
    seedDescription("a black phone lost near the library");
    render(<CreateReport />);
    const notImage = new File(["nope"], "notes.txt", { type: "text/plain" });
    const tooBig = new File([new Uint8Array(9 * 1024 * 1024)], "huge.jpg", { type: "image/jpeg" });
    const input = document.querySelector('input[type="file"]');
    if (!input) throw new Error("file input not found");
    fireEvent.change(input, { target: { files: [notImage, tooBig] } });
    // Both filenames appear with their distinct reasons — not one generic
    // message describing only the last failure.
    await screen.findByText(/notes\.txt: that file isn't an image/i);
    expect(screen.getByText(/huge\.jpg:.*under 8 mb/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /remove photo/i })).toBeNull();
  });

  it("discard draft after a failed recovery leaves a working empty form", async () => {
    seedDescription("a black phone lost near the library");
    saveDraft({
      ...loadDraft("u1")!,
      title: "Lost phone",
      category: "Electronics",
      photoId: "gone",
      photoIds: ["gone"],
    }, "u1");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      render(<CreateReport />);
      await screen.findByText(/could not be recovered/i);
      expect((screen.getByRole("button", { name: /publish/i }) as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: /discard draft/i }));
      await waitFor(() => expect(screen.queryByText(/could not be recovered/i)).toBeNull());
      // Recovery gate resolved: a completely new report can be started.
      expect((screen.getByRole("button", { name: /publish/i }) as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("");
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("previews converted bytes instead of the original HEIC picker URL", async () => {
    seedDescription("a black phone lost near the library");
    saveDraft({
      ...loadDraft("u1")!,
      title: "Lost phone",
      category: "Electronics",
      photoId: "h1",
      photoIds: ["h1"],
      photoRefs: [{ id: "h1", nativeUri: "content://heic-photo", webPath: "content://heic-photo", format: "heic" }],
    }, "u1");
    photo.photoToFile.mockResolvedValueOnce(new File(["jpeg-bytes"], "photo.jpg", { type: "image/jpeg" }));
    try {
      render(<CreateReport />);
      const img = await screen.findByRole("img", { name: /photo 1 of/i });
      // The WebView may not render HEIC: the thumbnail must be the converted
      // JPEG object URL, never the original HEIC resource.
      expect(img.getAttribute("src")).toBe("blob:preview");
    } finally {
      photo.photoToFile.mockReset();
    }
  });

  it("allows manual category selection without AI", async () => {
    publishReportMock.mockResolvedValue("p1");
    seedDescription("house keys on a blue lanyard");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost keys" } });
    await chooseCategory("Keys");
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() => expect(publishReportMock).toHaveBeenCalledWith(expect.objectContaining({ category: "Keys" }), null, expect.any(String)));
  });

  it("keeps the photo uploadable across navigation (draft restore)", async () => {
    publishReportMock.mockResolvedValue("p1");
    seedDescription("a black phone lost near the library");
    const { unmount } = render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    await chooseCategory("Electronics");
    const file = new File(["abc"], "p.jpg", { type: "image/jpeg" });
    pickFile(file);
    await screen.findByRole("button", { name: /remove photo/i });

    // Simulate leaving to Offline AI and coming back.
    unmount();
    render(<CreateReport />);
    expect(screen.getByRole("img", { name: /photo 1 of/i })).toBeTruthy();

    await waitFor(() => expect((screen.getByRole("button", { name: /publish/i }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() =>
      expect(publishReportMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Lost phone" }),
        expect.any(File),
        expect.any(String),
      ),
    );
  });

  it("surfaces a friendly error when native capture fails", async () => {
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

  it("never adds a sixth photo when native captures resolve together", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.takePhoto.mockImplementation(async () => ({ nativeUri: "file:///photo", webPath: "file:///photo", format: "jpg", id: crypto.randomUUID() }));
    photo.photoToFile.mockImplementation(async (picked: { id: string }) =>
      new File([picked.id], `${picked.id}.jpg`, { type: "image/jpeg" }),
    );
    try {
      render(<CreateReport />);
      const capture = await screen.findByRole("button", { name: /take photo/i });
      for (let i = 0; i < 6; i++) fireEvent.click(capture);
      // Six serialized captures (conversion + hash + render each) exceed the
      // default 1s waitFor budget under full-suite worker load.
      await waitFor(
        () => expect(screen.getAllByRole("button", { name: /remove photo/i })).toHaveLength(5),
        { timeout: 5000 },
      );
      expect(screen.getAllByRole("button", { name: /remove photo/i })).toHaveLength(5);
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      photo.takePhoto.mockReset();
      photo.photoToFile.mockReset();
    }
  });

  it("rejects an exact-byte duplicate between two native camera captures", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.takePhoto.mockImplementation(async () => ({ nativeUri: "file:///photo", webPath: "file:///photo", format: "jpg", id: crypto.randomUUID() }));
    photo.photoToFile.mockImplementation(async () => new File(["same-still"], "capture.jpg", { type: "image/jpeg" }));
    try {
      render(<CreateReport />);
      const capture = await screen.findByRole("button", { name: /take photo/i });
      fireEvent.click(capture);
      await screen.findByRole("button", { name: /remove photo/i });
      fireEvent.click(capture);
      await screen.findByText(/already selected/i);
      expect(screen.getAllByRole("button", { name: /remove photo/i })).toHaveLength(1);
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      photo.takePhoto.mockReset();
      photo.photoToFile.mockReset();
    }
  });

  it("rejects an oversized native capture before it can be published", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.takePhoto.mockResolvedValue({ nativeUri: "file:///large", webPath: "file:///large", format: "jpg", id: "large" });
    photo.photoToFile.mockResolvedValue(new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large.jpg", { type: "image/jpeg" }));
    try {
      render(<CreateReport />);
      fireEvent.click(screen.getByRole("button", { name: /take photo/i }));
      await screen.findByText(/too large/i);
      expect(screen.queryByRole("button", { name: /remove photo/i })).toBeNull();
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      photo.takePhoto.mockReset();
      photo.photoToFile.mockReset();
    }
  });

  it("does not let an invalid gallery item consume one of the five photo slots", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.chooseReportPhotos.mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({
      nativeUri: `file:///photo-${i}`, webPath: `file:///photo-${i}`, format: "jpg", id: `${i}`,
    })));
    photo.photoToFile.mockImplementation(async (picked: { id: string }) => new File(
      [picked.id === "0" ? new Uint8Array(8 * 1024 * 1024 + 1) : picked.id],
      `${picked.id}.jpg`, { type: "image/jpeg" },
    ));
    try {
      render(<CreateReport />);
      fireEvent.click(screen.getByRole("button", { name: /choose up to/i }));
      // The oversized first item is rejected with an alert and must not
      // consume one of the five slots...
      await screen.findByText(/that photo is too large/i, undefined, { timeout: 5000 });
      // ...while all five valid items still fill the lane. The six-item batch
      // (native conversion + SHA-256 + re-render per item) exceeds the default
      // 1s waitFor budget under full-suite worker load, so allow headroom.
      await waitFor(
        () => expect(screen.getAllByRole("button", { name: /remove photo/i })).toHaveLength(5),
        { timeout: 5000 },
      );
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      photo.chooseReportPhotos.mockReset();
      photo.photoToFile.mockReset();
    }
  });

  it("rejects a camera capture matching a previously chosen gallery photo", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.chooseReportPhotos.mockResolvedValue([{ nativeUri: "file:///gallery", webPath: "file:///gallery", format: "jpg", id: "gallery" }]);
    photo.takePhoto.mockResolvedValue({ nativeUri: "file:///camera", webPath: "file:///camera", format: "jpg", id: "camera" });
    photo.photoToFile.mockImplementation(async () => new File(["same"], "photo.jpg", { type: "image/jpeg" }));
    try {
      render(<CreateReport />);
      fireEvent.click(await screen.findByRole("button", { name: /choose up to/i }));
      await screen.findByRole("button", { name: /remove photo/i });
      fireEvent.click(screen.getByRole("button", { name: /take photo/i }));
      await screen.findByText(/already selected/i);
      expect(screen.getAllByRole("button", { name: /remove photo/i })).toHaveLength(1);
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      photo.takePhoto.mockReset();
      photo.photoToFile.mockReset();
      photo.chooseReportPhotos.mockReset();
    }
  });

  it("rejects a native capture matching a web-selected photo while hashing is queued", async () => {
    photo.takePhoto.mockResolvedValue({ nativeUri: "file:///camera", webPath: "file:///camera", format: "jpg", id: "camera" });
    photo.photoToFile.mockResolvedValue(new File(["same"], "capture.jpg", { type: "image/jpeg" }));
    try {
      render(<CreateReport />);
      pickFile(new File(["same"], "gallery.jpg", { type: "image/jpeg" }));
      photo.isNativeCameraAvailable.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: /take photo/i }));
      await screen.findByText(/already selected/i);
      expect(screen.getAllByRole("button", { name: /remove photo/i })).toHaveLength(1);
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      photo.takePhoto.mockReset();
      photo.photoToFile.mockReset();
    }
  });

  it("rejects a camera capture matching a restored draft photo", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.takePhoto.mockResolvedValue({ nativeUri: "file:///camera", webPath: "file:///camera", format: "jpg", id: "camera" });
    photo.photoToFile.mockResolvedValue(new File(["same"], "capture.jpg", { type: "image/jpeg" }));
    const id = stashPhotoFile(new File(["same"], "draft.jpg", { type: "image/jpeg" }), { accountId: "u1" });
    seedDescription("the restored photo");
    saveDraft({ ...loadDraft("u1")!, photoId: id, photoIds: [id] }, "u1");
    try {
      render(<CreateReport />);
      await screen.findByRole("button", { name: /remove photo/i });
      await waitFor(() => expect(screen.getByRole("button", { name: /take photo/i }).getAttribute("aria-disabled")).toBe("false"));
      fireEvent.click(screen.getByRole("button", { name: /take photo/i }));
      await screen.findByText(/already selected/i);
      expect(screen.getAllByRole("button", { name: /remove photo/i })).toHaveLength(1);
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      photo.takePhoto.mockReset();
      photo.photoToFile.mockReset();
    }
  });

  it("requires a date before publishing", async () => {
    publishReportMock.mockResolvedValue("p1");
    saveDraft({
      type: "LOST",
      title: "",
      description: "a black phone lost near the library",
      category: "",
      eventDate: "",
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    }, "u1");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    await chooseCategory("Electronics");
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/choose a date/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects non-image files before upload", async () => {
    render(<CreateReport />);
    pickFile(new File(["abc"], "notes.txt", { type: "text/plain" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/image/i);
    expect(screen.queryByRole("button", { name: /remove photo/i })).toBeNull();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects oversized images before upload", async () => {
    render(<CreateReport />);
    const big = new File([new Uint8Array(9 * 1024 * 1024)], "big.jpg", { type: "image/jpeg" });
    pickFile(big);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/too large|8 mb/i);
    expect(screen.queryByRole("button", { name: /remove photo/i })).toBeNull();
  });

  it("warns when the link is not a YouTube URL", async () => {
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/youtube link/i), { target: { value: "https://example.com/video" } });
    expect(await screen.findByText(/doesn't look like a youtube link/i)).toBeTruthy();
  });

  // Validation alignment tests (W6 #17)
  it("rejects title shorter than 3 characters", async () => {
    publishReportMock.mockResolvedValue("p1");
    seedDescription("a black phone lost near the library");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Ab" } });
    await chooseCategory("Electronics");
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/title must be at least 3 characters/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects title longer than 120 characters", async () => {
    publishReportMock.mockResolvedValue("p1");
    seedDescription("a black phone lost near the library");
    render(<CreateReport />);
    const longTitle = "A".repeat(121);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: longTitle } });
    await chooseCategory("Electronics");
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/title must be at most 120 characters/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects description shorter than 10 characters", async () => {
    publishReportMock.mockResolvedValue("p1");
    seedDescription("short");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    await chooseCategory("Electronics");
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/description must be at least 10 characters/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects description longer than 3000 characters", async () => {
    publishReportMock.mockResolvedValue("p1");
    const longDesc = "A".repeat(3001);
    seedDescription(longDesc);
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    await chooseCategory("Electronics");
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/description must be at most 3000 characters/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("rejects location label longer than 200 characters", async () => {
    publishReportMock.mockResolvedValue("p1");
    seedDescription("a black phone lost near the library");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    await chooseCategory("Electronics");
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
    }, "u1");
    render(<CreateReport />);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText(/choose a valid date/i)).toBeTruthy();
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("publishes a cutover category restored from a draft", async () => {
    publishReportMock.mockResolvedValue("p1");
    const { saveDraft } = await import("../services/reportDraft");
    saveDraft({
      type: "LOST",
      title: "Lost phone",
      description: "a black phone lost near the library",
      category: "Phones & Tablets",
      eventDate: todayInputValue(),
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    }, "u1");
    render(<CreateReport />);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() =>
      expect(publishReportMock).toHaveBeenCalledWith(
        expect.objectContaining({ category: "Phones & Tablets" }),
        null,
        expect.any(String),
      ),
    );
  });

  it("still drops an unknown category restored from a corrupt draft", async () => {
    publishReportMock.mockResolvedValue("p1");
    const { saveDraft } = await import("../services/reportDraft");
    saveDraft({
      type: "LOST",
      title: "Lost phone",
      description: "a black phone lost near the library",
      category: "Spaceships" as never,
      eventDate: todayInputValue(),
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    }, "u1");
    render(<CreateReport />);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(await screen.findByText("Choose a category.")).toBeTruthy();
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
    expect(screen.getByRole("img", { name: /photo 1 of/i })).toBeTruthy();
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
    seedDescription("a black phone lost near the library");
    render(<CreateReport />);
    fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: "Lost phone" } });
    await chooseCategory("Electronics");
    pickFile(new File(["abc"], "p.jpg", { type: "image/jpeg" }));
    await screen.findByRole("button", { name: /remove photo/i });

    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() => expect(publishReportMock).toHaveBeenCalled());

    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});
