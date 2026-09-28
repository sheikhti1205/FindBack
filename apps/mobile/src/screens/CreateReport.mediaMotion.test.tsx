// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishReportMock, publishReportWithPhotosMock, photo } = vi.hoisted(() => ({
  publishReportMock: vi.fn(),
  publishReportWithPhotosMock: vi.fn(),
  photo: {
    isNativeCameraAvailable: vi.fn(() => false),
    takePhoto: vi.fn(),
    chooseFromGallery: vi.fn(),
    chooseReportPhotos: vi.fn(),
    photoToFile: vi.fn(),
    normalizeForUpload: vi.fn(async (file: File) => file),
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
import { clearPhotoStore } from "../services/photoStore";
import { todayInputValue } from "../utils/dates";
import { chooseCategory } from "../test-utils/reportCategory";

function seedBasics(): void {
  saveDraft(
    {
      type: "LOST",
      title: "",
      description: "a black phone lost near the library entrance",
      category: "",
      eventDate: todayInputValue(),
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    },
    "u1",
  );
}

async function fillTitleCategory(title: string): Promise<void> {
  fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: title } });
  await chooseCategory("Electronics");
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

async function addWebPhoto(name: string, count: number): Promise<void> {
  fireEvent.change(fileInput(), {
    target: { files: [new File([`bytes-${name}`], name, { type: "image/jpeg" })] },
  });
  // Tiles relabel to "N of N" once the new photo joins, so this waits for the
  // specific batch position instead of matching any existing tile.
  await screen.findByRole("img", { name: new RegExp(`photo ${count} of ${count}`, "i") }, { timeout: 3000 });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  publishReportMock.mockReset();
  publishReportWithPhotosMock.mockReset();
  publishReportWithPhotosMock.mockResolvedValue("p-multi");
  publishReportMock.mockResolvedValue("p1");
  photo.isNativeCameraAvailable.mockReset();
  photo.isNativeCameraAvailable.mockReturnValue(false);
  photo.chooseReportPhotos.mockReset();
  photo.photoToFile.mockReset();
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

// Real-timer policy for this file (Wave B probe): no fake timers anywhere, so
// animation waits use waitFor with generous timeouts.
describe("CreateReport media motion", () => {
  it("opens the lightbox from a photo tile, steps with next, and closes back out", async () => {
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    await addWebPhoto("one.jpg", 1);
    await addWebPhoto("two.jpg", 2);

    fireEvent.click(screen.getByRole("button", { name: /view photo 1 of 2 full size/i }));
    const dialog = await screen.findByRole("dialog", { name: "Photo 1 of 2" }, { timeout: 3000 });

    // Parent wires wrap-around navigation into the lightbox controls.
    fireEvent.click(screen.getByRole("button", { name: /next photo/i }));
    await screen.findByRole("dialog", { name: "Photo 2 of 2" }, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: /previous photo/i }));
    await screen.findByRole("dialog", { name: "Photo 1 of 2" }, { timeout: 3000 });

    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /close photo preview/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 3000 });
  }, 15000);

  it("crossfades the batch status from processing into the ready notice", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    try {
      seedBasics();
      render(<CreateReport />);
      await fillTitleCategory("Lost phone");

      let release!: (file: File) => void;
      const gate = new Promise<File>((resolve) => {
        release = resolve;
      });
      photo.chooseReportPhotos.mockResolvedValueOnce([
        { nativeUri: "content://media/1", webPath: "content://media/1", format: "jpg", id: "n1" },
      ]);
      photo.photoToFile.mockImplementationOnce(() => gate);

      fireEvent.click(screen.getByRole("button", { name: /choose up to \d+ photos/i }));

      const processing = await screen.findByTestId("photo-pick-status", undefined, { timeout: 3000 });
      expect(processing.getAttribute("data-status")).toBe("processing");
      expect(screen.getByRole("button", { name: /^cancel$/i })).toBeTruthy();

      release(new File(["first-bytes"], "ok1.jpg", { type: "image/jpeg" }));

      // The processing slot and the notice coexist only for the crossfade
      // window; settle on the final notice with exactly one status left.
      await waitFor(
        () => {
          const all = screen.getAllByTestId("photo-pick-status");
          expect(all.some((el) => el.getAttribute("data-status") === "notice")).toBe(true);
        },
        { timeout: 3000 },
      );
      await waitFor(() => expect(screen.queryByText(/processing/i)).toBeNull(), { timeout: 3000 });
      const settled = screen.getAllByTestId("photo-pick-status");
      expect(settled).toHaveLength(1);
      expect(settled[0]!.getAttribute("data-status")).toBe("notice");
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      photo.chooseReportPhotos.mockReset();
      photo.photoToFile.mockReset();
    }
  }, 15000);

  it("reports real upload percentages on the progress bar", async () => {
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    await addWebPhoto("one.jpg", 1);
    await addWebPhoto("two.jpg", 2);

    publishReportWithPhotosMock.mockImplementationOnce(
      (_report: unknown, _files: unknown, options: { onProgress?: (p: { completed: number; total: number }) => void } = {}) =>
        (async () => {
          options.onProgress?.({ completed: 0, total: 2 });
          await delay(150);
          options.onProgress?.({ completed: 1, total: 2 });
          await delay(500);
          options.onProgress?.({ completed: 2, total: 2 });
          await delay(600);
          return "p-multi";
        })(),
    );
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);

    const bar = await screen.findByRole("progressbar", undefined, { timeout: 3000 });
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    // 0/2 and 1/2 are the only observed states on the way up — the bar never
    // runs ahead of the counts it is derived from.
    await waitFor(() => expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50"), {
      timeout: 3000,
    });
    expect(screen.getByText(/uploading 2 of 2/i)).toBeTruthy();
    expect(Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"))).toBeLessThanOrEqual(50);

    await waitFor(() => expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100"), {
      timeout: 3000,
    });
    expect(screen.getByText(/publishing/i)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull(), { timeout: 3000 });
  }, 15000);

  it("shows the YouTube poster until playback is requested, then crossfades to the player", async () => {
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    fireEvent.change(screen.getByLabelText(/youtube link/i), {
      target: { value: "https://youtu.be/dQw4w9WgXcQ" },
    });

    const poster = await screen.findByTestId("youtube-poster", undefined, { timeout: 3000 });
    expect(document.querySelector('iframe[title="Embedded YouTube video"]')).toBeNull();

    fireEvent.click(poster);
    expect(await screen.findByTitle("Embedded YouTube video", undefined, { timeout: 3000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("youtube-poster")).toBeNull(), { timeout: 3000 });
  }, 15000);
});
