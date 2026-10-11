// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishReportMock, publishReportWithPhotosMock, photo, nativeMedia } = vi.hoisted(() => ({
  publishReportMock: vi.fn(),
  publishReportWithPhotosMock: vi.fn(),
  photo: {
    isNativeCameraAvailable: vi.fn(() => false),
    takePhoto: vi.fn(),
    chooseFromGallery: vi.fn(),
    photoToFile: vi.fn(),
    normalizeForUpload: vi.fn(async (file: File) => file),
    toNativeImageUri: vi.fn(),
  },
  nativeMedia: {
    chooseNativeImage: vi.fn(),
    chooseNativeImages: vi.fn(),
    importNativeImageUri: vi.fn(),
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

describe("CreateReport editor preservation (ED-05 guard)", () => {
  it("adding/removing photos never remounts the description editor", async () => {
    seedBasics();
    render(<CreateReport />);
    const toolbar = await screen.findByRole("toolbar", { name: /description formatting/i });

    // Add two photos: the editor instance must stay the exact same DOM node
    // (a remount would drop cursor/selection).
    pickFile(new File(["one"], "one.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /photo 1 of/i });
    pickFile(new File(["two"], "two.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /photo 2 of/i });
    expect(screen.getByRole("toolbar", { name: /description formatting/i })).toBe(toolbar);

    // Reorder + remove: still the same editor node.
    fireEvent.click(screen.getByRole("button", { name: /move photo 2 earlier/i }));
    expect(screen.getByRole("toolbar", { name: /description formatting/i })).toBe(toolbar);
    fireEvent.click(screen.getByRole("button", { name: /remove photo 1/i }));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: /photo 2 of/i })).toBeNull(),
    );
    expect(screen.getByRole("toolbar", { name: /description formatting/i })).toBe(toolbar);
  });

  it("durable restore on mount never remounts the description editor", async () => {
    seedBasics();
    render(<CreateReport />);
    const toolbar = await screen.findByRole("toolbar", { name: /description formatting/i });
    // Let any async durable-restore effect settle, then confirm identity.
    await waitFor(() => expect(publishReportMock).not.toHaveBeenCalled());
    expect(screen.getByRole("toolbar", { name: /description formatting/i })).toBe(toolbar);
  });
});
