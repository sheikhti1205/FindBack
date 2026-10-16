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
import { clearPhotoStore } from "../services/photoStore";
import { todayInputValue } from "../utils/dates";

import { chooseCategory } from "../test-utils/reportCategory";
function seedBasics(): void {
  saveDraft({
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
  }, "u1");
}

function pickFile(file: File): void {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  if (inputs.length === 0) throw new Error("file input not found");
  const input = inputs[inputs.length - 1] as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

async function fillTitleCategory(title: string): Promise<void> {
  fireEvent.change(screen.getByLabelText(/what did you lose/i), { target: { value: title } });
  await chooseCategory("Electronics");
}

function submit(): void {
  fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
}

beforeEach(() => {
  publishReportMock.mockReset();
  publishReportWithPhotosMock.mockReset();
  publishReportWithPhotosMock.mockResolvedValue("p-multi");
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

describe("CreateReport multi-image", () => {
  it("a single photo still uses the legacy single-photo publish path", async () => {
    publishReportMock.mockResolvedValue("p1");
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    const file = new File(["abc"], "p.jpg", { type: "image/jpeg" });
    pickFile(file);
    submit();

    await waitFor(() =>
      expect(publishReportMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Lost phone" }),
        file,
        expect.any(String),
      ),
    );
    expect(publishReportWithPhotosMock).not.toHaveBeenCalled();
  });

  it("P5 red: a single photo shows no reorder controls", async () => {
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    pickFile(new File(["one"], "one.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /photo 1 of/i });

    expect(screen.queryByRole("button", { name: /move photo 1 (left|right)/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /make photo 1 the cover/i })).toBeNull();
    expect(screen.getByRole("button", { name: /remove photo 1/i })).toBeTruthy();
  });

  it("two photos publish in displayed order via the multi path", async () => {
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    const first = new File(["one"], "one.jpg", { type: "image/jpeg" });
    const second = new File(["two"], "two.jpg", { type: "image/jpeg" });
    pickFile(first);
    await screen.findByRole("img", { name: /photo 1 of/i });
    pickFile(second);
    await screen.findByRole("img", { name: /photo 2 of/i });
    submit();

    await waitFor(() =>
      expect(publishReportWithPhotosMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Lost phone" }),
        [first, second],
        expect.objectContaining({ traceId: expect.any(String) }),
      ),
    );
    expect(publishReportMock).not.toHaveBeenCalled();
  });

  it("moving a photo left changes the published order", async () => {
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    const first = new File(["one"], "one.jpg", { type: "image/jpeg" });
    const second = new File(["two"], "two.jpg", { type: "image/jpeg" });
    pickFile(first);
    await screen.findByRole("img", { name: /photo 1 of/i });
    pickFile(second);
    await screen.findByRole("img", { name: /photo 2 of/i });

    // The action row follows the visible slide, so page to photo 2 first.
    fireEvent.click(screen.getByRole("button", { name: "Go to photo 2" }));
    fireEvent.click(screen.getByRole("button", { name: /move photo 2 left/i }));
    submit();

    await waitFor(() =>
      expect(publishReportWithPhotosMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Lost phone" }),
        [second, first],
        expect.objectContaining({ traceId: expect.any(String) }),
      ),
    );
  });

  it("removing the middle photo publishes the rest in order", async () => {
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    const first = new File(["one"], "one.jpg", { type: "image/jpeg" });
    const second = new File(["two"], "two.jpg", { type: "image/jpeg" });
    const third = new File(["three"], "three.jpg", { type: "image/jpeg" });
    pickFile(first);
    await screen.findByRole("img", { name: /photo 1 of/i });
    pickFile(second);
    await screen.findByRole("img", { name: /photo 2 of/i });
    pickFile(third);
    await screen.findByRole("img", { name: /photo 3 of/i });

    fireEvent.click(screen.getByRole("button", { name: "Go to photo 2" }));
    fireEvent.click(screen.getByRole("button", { name: /remove photo 2/i }));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: /photo 3 of/i })).toBeNull(),
    );
    submit();

    await waitFor(() =>
      expect(publishReportWithPhotosMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Lost phone" }),
        [first, third],
        expect.objectContaining({ traceId: expect.any(String) }),
      ),
    );
  });

  it("removing a photo releases its bytes so the same file can be added again", async () => {
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    const bytes = new File(["same-bytes"], "wallet.jpg", { type: "image/jpeg" });
    pickFile(bytes);
    await screen.findByRole("img", { name: /photo 1 of/i });

    fireEvent.click(screen.getByRole("button", { name: /remove photo 1/i }));
    await waitFor(() => expect(screen.queryByRole("img", { name: /photo 1 of/i })).toBeNull());

    // Reselecting the identical bytes must be accepted, not treated as a duplicate.
    pickFile(new File(["same-bytes"], "wallet.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /photo 1 of/i });
    expect(screen.getByRole("img", { name: /photo 1 of/i })).toBeTruthy();
  });

  it("two rapid picker actions never exceed the five-photo cap", async () => {
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    const batchOne = Array.from({ length: 5 }, (_, n) =>
      new File([`first-${n}`], `a${n}.jpg`, { type: "image/jpeg" }),
    );
    const batchTwo = Array.from({ length: 5 }, (_, n) =>
      new File([`second-${n}`], `b${n}.jpg`, { type: "image/jpeg" }),
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: batchOne } });
    fireEvent.change(input, { target: { files: batchTwo } });

    await screen.findByRole("img", { name: /photo 5 of/i });
    await waitFor(() =>
      expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(5),
    );
    expect(screen.getByText("5/5")).toBeTruthy();
  });

  it("publishing immediately after a duplicate pick still sends one file", async () => {
    publishReportMock.mockResolvedValue("p1");
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    // Same bytes, two names, same tick: the digest check must settle before publish.
    fireEvent.change(input, { target: { files: [new File(["dup-bytes"], "one.jpg", { type: "image/jpeg" })] } });
    fireEvent.change(input, { target: { files: [new File(["dup-bytes"], "two.jpg", { type: "image/jpeg" })] } });
    submit();

    await waitFor(() => expect(publishReportMock).toHaveBeenCalled());
    const files = publishReportMock.mock.calls[0]![1] as File | File[] | null;
    expect(Array.isArray(files) ? files : [files]).toHaveLength(1);
  });

  it("five photos show the cap message and no sixth can be added", async () => {
    seedBasics();
    render(<CreateReport />);
    for (let n = 1; n <= 5; n += 1) {
      pickFile(new File([`bytes-${n}`], `p${n}.jpg`, { type: "image/jpeg" }));
      await screen.findByRole("img", { name: new RegExp(`photo ${n} of`, "i") });
    }

    expect(await screen.findByText(/maximum of 5 photos reached/i)).toBeTruthy();
    expect(screen.getByText("5/5")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /choose up to 0 photos/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("a failed multi publish keeps every photo so the draft can be retried", async () => {
    publishReportWithPhotosMock.mockRejectedValue(new Error("Could not publish"));
    seedBasics();
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    pickFile(new File(["one"], "one.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /photo 1 of/i });
    pickFile(new File(["two"], "two.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /photo 2 of/i });
    submit();

    await screen.findByText(/could not publish/i);
    expect(screen.getByRole("img", { name: /photo 1 of/i })).toBeTruthy();
    expect(screen.getByRole("img", { name: /photo 2 of/i })).toBeTruthy();
  });

  it("markdown round-trip still publishes the editor content with photos", async () => {
    seedBasics();
    saveDraft({
      type: "LOST",
      title: "",
      description: "**bold** lost phone near the library",
      category: "",
      eventDate: todayInputValue(),
      location: { label: "", latitude: null, longitude: null },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
    }, "u1");
    render(<CreateReport />);
    await fillTitleCategory("Lost phone");
    pickFile(new File(["one"], "one.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /photo 1 of/i });
    pickFile(new File(["two"], "two.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /photo 2 of/i });
    submit();

    await waitFor(() =>
      expect(publishReportWithPhotosMock).toHaveBeenCalledWith(
        expect.objectContaining({ description: "**bold** lost phone near the library" }),
        expect.any(Array),
        expect.objectContaining({ traceId: expect.any(String) }),
      ),
    );
  });

  it("names each failed native selection by position without leaking native URIs", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    try {
      seedBasics();
      render(<CreateReport />);
      nativeMedia.chooseNativeImages.mockResolvedValueOnce(["content://media/1", "content://media/2"]);
      // Marked exactly like photo.ts marks safe conversion failures.
      const heicError = new Error(
        "This HEIC/HEIF photo could not be decoded on this device. Export it as JPEG and try again.",
      );
      heicError.name = "PhotoImportError";
      nativeMedia.importNativeImageUri.mockRejectedValueOnce(heicError).mockResolvedValueOnce(imported("good-bytes", { fileName: "ok.jpg" }));
      fireEvent.click(screen.getByRole("button", { name: /choose up to \d+ photos/i }));
      // The failed first selection is named by position with its actionable
      // reason, while the valid second photo still lands in the tray.
      await screen.findByText(/photo 1 couldn't be added/i);
      await screen.findByText(/export it as jpeg/i);
      await screen.findByRole("img", { name: /photo 1 of 1/i });
      const failures = screen.getByRole("list", { name: /photos that couldn't be added/i });
      expect(failures.textContent).not.toMatch(/content:\/\/|file:\/\/|blob:/i);
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(false);
      nativeMedia.chooseNativeImages.mockReset();
      nativeMedia.importNativeImageUri.mockReset();
    }
  });
});
