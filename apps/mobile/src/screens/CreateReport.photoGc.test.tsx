// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { photo } = vi.hoisted(() => ({
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
vi.mock("../services/photo", () => photo);

import { CreateReport } from "./CreateReport";
import { clearDraft, saveDraft } from "../services/reportDraft";
import { clearPhotoStore } from "../services/photoStore";
import { todayInputValue } from "../utils/dates";

function pickFile(file: File): void {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  if (inputs.length === 0) throw new Error("file input not found");
  const input = inputs[inputs.length - 1] as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe("CreateReport blob URL GC (G15)", () => {
  beforeEach(() => {
    clearDraft();
    clearPhotoStore();
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
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:preview");
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    clearDraft();
    clearPhotoStore();
  });

  it("revokes the blob URL when a photo is removed", async () => {
    render(<CreateReport />);
    pickFile(new File(["one"], "one.jpg", { type: "image/jpeg" }));
    await screen.findByRole("img", { name: /photo 1 of/i });

    fireEvent.click(screen.getByRole("button", { name: /remove photo 1/i }));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: /photo 1 of/i })).toBeNull(),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
});
