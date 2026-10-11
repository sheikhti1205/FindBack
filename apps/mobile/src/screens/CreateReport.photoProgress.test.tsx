// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishReportMock, publishReportWithPhotosMock, photo, nativeMedia } = vi.hoisted(() => ({
  publishReportMock: vi.fn(),
  publishReportWithPhotosMock: vi.fn(),
  photo: {
    isNativeCameraAvailable: vi.fn(() => false),
    normalizeForUpload: vi.fn(async (file: File) => file),
  },
  nativeMedia: {
    chooseNativeImage: vi.fn(),
    chooseNativeImages: vi.fn(),
    importNativeImageUri: vi.fn(),
  },
}));

/** ImportedImage-shaped fixture: only the fields importedImageToFile touches. */
function imported(bytes: Uint8Array | string, opts?: { fileName?: string; motionStillUsed?: boolean }) {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return {
    id: crypto.randomUUID(),
    fileName: opts?.fileName ?? "photo.jpg",
    motionStillUsed: opts?.motionStillUsed ?? false,
    derivative: { bytes: data, mimeType: "image/jpeg", byteLength: data.length, width: 8, height: 8, quality: 0.82 },
  };
}

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
vi.mock("../services/media/nativeMedia", () => ({
  chooseNativeImage: nativeMedia.chooseNativeImage,
  chooseNativeImages: nativeMedia.chooseNativeImages,
  importNativeImageUri: nativeMedia.importNativeImageUri,
  // Faithful copy of the production helper (pure): the real module registers
  // the Capacitor plugin at import time, which the web-platform mock lacks.
  importedImageToFile: (item: { fileName?: string; derivative: { bytes: Uint8Array; mimeType: string } }) =>
    new File([item.derivative.bytes.slice()], item.fileName || "photo.jpg", { type: item.derivative.mimeType }),
}));

import { CreateReport } from "./CreateReport";
import { clearDraft, saveDraft } from "../services/reportDraft";
import * as photoStore from "../services/photoStore";
import { clearPhotoStore } from "../services/photoStore";
import { todayInputValue } from "../utils/dates";

import { chooseCategory } from "../test-utils/reportCategory";

const persistPhotos = photoStore.persistStashedPhotos;
const pendingPhotoSaves = new Set<ReturnType<typeof persistPhotos>>();

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

function submit(): void {
  fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  vi.spyOn(photoStore, "persistStashedPhotos").mockImplementation((...args) => {
    const save = persistPhotos(...args);
    pendingPhotoSaves.add(save);
    void save.then(() => pendingPhotoSaves.delete(save), () => pendingPhotoSaves.delete(save));
    return save;
  });
  publishReportMock.mockReset();
  publishReportWithPhotosMock.mockReset();
  publishReportWithPhotosMock.mockResolvedValue("p-multi");
  publishReportMock.mockResolvedValue("p1");
  photo.isNativeCameraAvailable.mockReset();
  photo.isNativeCameraAvailable.mockReturnValue(false);
  nativeMedia.chooseNativeImages.mockReset();
  nativeMedia.importNativeImageUri.mockReset();
  photo.normalizeForUpload.mockClear();
  clearDraft();
  clearPhotoStore();
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:preview");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(async () => {
  cleanup();
  // Draft persistence uses real asynchronous FileReaders. Drain those writes
  // before jsdom tears down its realm; otherwise a late data-URL conversion
  // can run against the next realm's Uint8Array and throw out of band.
  await Promise.allSettled([...pendingPhotoSaves]);
  vi.restoreAllMocks();
  clearDraft();
  clearPhotoStore();
});

describe("CreateReport photo progress + cancel (Lane C)", () => {
  // Generous timeout: this test chains real delays (1000ms conversion +
  // 250ms settle) with several animated UI waits under parallel load.
  // Test-only change.
  it("shows Processing N of M with Cancel; cancelling keeps accepted tiles and stops pending ones", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    try {
      seedBasics();
      render(<CreateReport />);
      await fillTitleCategory("Lost phone");

      nativeMedia.chooseNativeImages.mockResolvedValueOnce(["content://media/1", "content://media/2"]);
      nativeMedia.importNativeImageUri
        .mockImplementationOnce(async () => imported("first-bytes", { fileName: "ok1.jpg" }))
        .mockImplementationOnce(async () => {
          // Wide cancel window (test-only): the click below must land while
          // this conversion is still in flight even when parallel load slows
          // the test steps; the abort is observed when this resolves.
          await delay(1000);
          return imported("second-bytes", { fileName: "ok2.jpg" });
        });

      fireEvent.click(screen.getByRole("button", { name: /choose up to \d+ photos/i }));

      // Progress status appears and advances as the first photo lands.
      await screen.findByText(/processing 1 of 2/i);
      // Quiescence gate: under parallel load Cancel may lag the status line,
      // so wait for it instead of asserting it is already in the DOM.
      const cancelButton = await screen.findByRole("button", { name: /^cancel$/i }, {
        timeout: 3000,
      });
      expect(cancelButton).toBeTruthy();

      // Cancel while the second conversion is still in flight: its result is
      // discarded, so no second tile ever appears. Click the already-found
      // button — re-querying after further waits risks missing the cancel
      // window under parallel load.
      fireEvent.click(cancelButton);
      await screen.findByText(/cancelled/i, undefined, { timeout: 5000 });
      await screen.findByRole("img", { name: /photo 1 of 1/i });
      await delay(250);
      expect(screen.queryByRole("img", { name: /photo 2 of/i })).toBeNull();
      expect(screen.getByRole("img", { name: /photo 1 of 1/i })).toBeTruthy();
      expect(screen.queryByText(/processing \d+ of/i)).toBeNull();
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      nativeMedia.chooseNativeImages.mockReset();
      nativeMedia.importNativeImageUri.mockReset();
    }
  }, 15000);

  it("multi-photo publish shows Uploading i/N with cancel; cancelling keeps photos for retry", async () => {
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["one"], "one.jpg", { type: "image/jpeg" })] },
    });
    await screen.findByRole("img", { name: /photo 1 of/i });
    fireEvent.change(input, {
      target: { files: [new File(["two"], "two.jpg", { type: "image/jpeg" })] },
    });
    await screen.findByRole("img", { name: /photo 2 of/i });

    // Complete the first upload explicitly after Cancel. A wall-clock timer
    // can fire before the click under worker load, leaving this deferred
    // publisher with no further progress callback to observe the abort.
    let finishFirstUpload!: () => void;
    publishReportWithPhotosMock.mockImplementationOnce(
      (_report: unknown, _files: unknown, options: { onProgress?: (p: { completed: number; total: number }) => void } = {}) =>
        new Promise<string>((_resolve, reject) => {
          try {
            options.onProgress?.({ completed: 0, total: 2 });
          } catch (err) {
            reject(err);
            return;
          }
          finishFirstUpload = () => {
            try {
              options.onProgress?.({ completed: 1, total: 2 });
            } catch (err) {
              reject(err);
            }
          };
        }),
    );
    submit();

    await screen.findByText(/uploading 1 of 2/i);
    expect(screen.getByRole("button", { name: /cancel upload/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /cancel upload/i }));
    finishFirstUpload();

    await screen.findByText(/upload cancelled/i);
    // Photos are kept for retry after a cancelled publish.
    expect(screen.getByRole("img", { name: /photo 1 of/i })).toBeTruthy();
    expect(screen.getByRole("img", { name: /photo 2 of/i })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/uploading \d+ of/i)).toBeNull());
  });

  it("surfaces the queue backlog in the status line while a batch is running", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    try {
      seedBasics();
      render(<CreateReport />);
      await fillTitleCategory("Lost phone");

      // First batch hangs in conversion; the second gallery tap queues behind
      // it instead of racing the hash registry — and the backlog is visible.
      let releaseFirst!: (value: ReturnType<typeof imported>) => void;
      const firstGate = new Promise<ReturnType<typeof imported>>((resolve) => {
        releaseFirst = resolve;
      });
      nativeMedia.chooseNativeImages
        .mockResolvedValueOnce(["content://media/1"])
        .mockResolvedValueOnce(["content://media/2"]);
      nativeMedia.importNativeImageUri
        .mockImplementationOnce(() => firstGate)
        .mockImplementation(async () => imported("second-bytes", { fileName: "ok2.jpg" }));

      const gallery = screen.getByRole("button", { name: /choose up to \d+ photos/i });
      fireEvent.click(gallery);
      await screen.findByText(/processing 0 of 1/i);
      fireEvent.click(gallery);
      await screen.findByText(/1 batch queued/);

      releaseFirst(imported("first-bytes", { fileName: "ok1.jpg" }));
      await screen.findByRole("img", { name: /photo 2 of 2/i });
      await waitFor(() => expect(screen.queryByText(/batch queued/)).toBeNull());
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      nativeMedia.chooseNativeImages.mockReset();
      nativeMedia.importNativeImageUri.mockReset();
    }
  });

  it("a newer queued gallery batch supersedes an obsolete one, camera captures are never dropped", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    try {
      seedBasics();
      render(<CreateReport />);
      await fillTitleCategory("Lost phone");

      let releaseFirst!: (value: ReturnType<typeof imported>) => void;
      const firstGate = new Promise<ReturnType<typeof imported>>((resolve) => {
        releaseFirst = resolve;
      });
      nativeMedia.chooseNativeImages
        .mockResolvedValueOnce(["content://media/1"])
        .mockResolvedValueOnce(["content://media/2"])
        .mockResolvedValueOnce(["content://media/3"]);
      const convertedUris: string[] = [];
      nativeMedia.importNativeImageUri
        .mockImplementationOnce(() => firstGate)
        .mockImplementation(async (uri: string) => {
          convertedUris.push(uri);
          return imported(`${uri}-bytes`, { fileName: `${uri.split("/").pop()}.jpg` });
        });

      const gallery = screen.getByRole("button", { name: /choose up to \d+ photos/i });
      fireEvent.click(gallery);
      await screen.findByText(/processing 0 of 1/i);
      // Two rapid re-taps while the first batch is stuck: the middle queued
      // batch is obsolete and dropped, only the latest runs.
      fireEvent.click(gallery);
      fireEvent.click(gallery);
      releaseFirst(imported("first-bytes", { fileName: "ok1.jpg" }));

      await screen.findByRole("img", { name: /photo 2 of 2/i });
      expect(convertedUris).toEqual(["content://media/3"]);
      expect(screen.queryByRole("img", { name: /photo 3 of/i })).toBeNull();
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      nativeMedia.chooseNativeImages.mockReset();
      nativeMedia.importNativeImageUri.mockReset();
    }
  });

  it("publish hides Cancel beyond the point of no return (final staged -> committing)", async () => {
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["one"], "one.jpg", { type: "image/jpeg" })] },
    });
    await screen.findByRole("img", { name: /photo 1 of/i });
    fireEvent.change(input, {
      target: { files: [new File(["two"], "two.jpg", { type: "image/jpeg" })] },
    });
    await screen.findByRole("img", { name: /photo 2 of/i });

    // Staging completes (2/2) then create-post hangs: Cancel must NOT be
    // offered while the commit is in flight (point of no return).
    let releaseCommit!: (id: string) => void;
    const commitGate = new Promise<string>((resolve) => {
      releaseCommit = resolve;
    });
    publishReportWithPhotosMock.mockImplementationOnce(
      (_report: unknown, _files: unknown, options: { onProgress?: (p: { completed: number; total: number }) => void } = {}) =>
        (async () => {
          options.onProgress?.({ completed: 1, total: 2 });
          await delay(200);
          options.onProgress?.({ completed: 2, total: 2 });
          return commitGate;
        })(),
    );
    submit();

    await screen.findByText(/uploading [12] of 2/i);
    expect(screen.getByRole("button", { name: /cancel upload/i })).toBeTruthy();
    // After the final photo stages, the commit phase must not offer Cancel.
    await waitFor(() => expect(screen.queryByRole("button", { name: /cancel upload/i })).toBeNull());
    releaseCommit("p-multi");
    await waitFor(() => expect(publishReportWithPhotosMock).toHaveBeenCalled());
  });

  it("multi-photo publish passes onProgress and streams Uploading i/N to completion", async () => {
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["one"], "one.jpg", { type: "image/jpeg" })] },
    });
    await screen.findByRole("img", { name: /photo 1 of/i });
    fireEvent.change(input, {
      target: { files: [new File(["two"], "two.jpg", { type: "image/jpeg" })] },
    });
    await screen.findByRole("img", { name: /photo 2 of/i });

    publishReportWithPhotosMock.mockImplementationOnce(
      (_report: unknown, _files: unknown, options: { onProgress?: (p: { completed: number; total: number }) => void } = {}) =>
        (async () => {
          options.onProgress?.({ completed: 0, total: 2 });
          await delay(20);
          options.onProgress?.({ completed: 1, total: 2 });
          await delay(20);
          return "p-multi";
        })(),
    );
    submit();

    await screen.findByText(/uploading 1 of 2/i);
    await waitFor(() => expect(publishReportWithPhotosMock).toHaveBeenCalled());
    const options = publishReportWithPhotosMock.mock.calls[0]?.[2] as
      | { onProgress?: (p: { completed: number; total: number }) => void }
      | undefined;
    expect(typeof options?.onProgress).toBe("function");
  });
});
