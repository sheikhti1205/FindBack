// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishReportMock, photo, nativeMedia } = vi.hoisted(() => ({
  publishReportMock: vi.fn(),
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
  return { ...actual, publishReport: (...args: unknown[]) => publishReportMock(...args) };
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
import { clearDraft } from "../services/reportDraft";
import { clearPhotoStore } from "../services/photoStore";

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

describe("CreateReport workset2 editor", () => {
  it("uses the visual editor without MarkdownComposer tabs or literal syntax", async () => {
    render(<CreateReport />);
    expect(screen.queryByRole("tab", { name: /write/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: /preview/i })).toBeNull();
    expect(screen.queryByText(/markdown supported/i)).toBeNull();
    expect(screen.getByRole("toolbar", { name: /description formatting/i })).toBeTruthy();
    expect(screen.getByLabelText("Character count")).toBeTruthy();
  });
});
