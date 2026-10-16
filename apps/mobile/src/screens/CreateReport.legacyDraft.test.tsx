// @vitest-environment jsdom
/**
 * §20: a draft written before the AI surfaces were removed still opens. The
 * restore is read by the form, so this asserts what the person actually sees:
 * the text they typed and the photo they added are back, and none of the retired
 * AI metadata — not its values, not its field names — reaches the screen.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  importedImageToFile: (item: { fileName?: string; derivative: { bytes: Uint8Array; mimeType: string } }) =>
    new File([item.derivative.bytes.slice()], item.fileName || "photo.jpg", { type: item.derivative.mimeType }),
}));

import { CreateReport } from "./CreateReport";
import { clearDraft } from "../services/reportDraft";
import { clearPhotoStore, stashPhotoFile } from "../services/photoStore";

const DRAFT_KEY = "findback:reportDraft:v1:u1";

/** What a build before the removal would have left on disk. */
function seedLegacyDraft(photoId: string) {
  localStorage.setItem(
    DRAFT_KEY,
    JSON.stringify({
      type: "FOUND",
      title: "Black backpack",
      description: "blue tag on the zip",
      category: "Bags & Wallets",
      eventDate: "2026-08-01",
      location: { label: "Library steps", latitude: 51.5072, longitude: -0.1276 },
      youtubeUrl: "",
      photoId,
      photoNativeUri: null,
      photoWebPath: "blob:legacy-preview",
      photoFormat: "jpeg",
      photoIds: [photoId],
      photoRefs: [{ id: photoId, format: "jpeg" }],
      // The retired AI metadata, in the shapes that build wrote.
      vlmSummary: "a black backpack on a bench",
      aiSuggestions: { category: "Bags & Wallets", confidence: 0.94 },
      grounding: [{ label: "backpack", box: [1, 2, 3, 4] }],
      modelId: "qwen2.5-vl-3b-instruct",
      photoAi: { caption: "bench" },
      suggestedCategory: "Bags & Wallets",
      assistState: "ready",
      confidence: 0.94,
    }),
  );
}

/** The retired values and field names that must never reach the screen. */
const MUST_NOT_APPEAR = [
  "qwen2.5",
  "0.94",
  "vlmSummary",
  "grounding",
  "photoAi",
  "modelId",
  "assistState",
  "confidence",
  "a black backpack on a bench",
];

afterEach(() => {
  cleanup();
  localStorage.removeItem(DRAFT_KEY);
  clearDraft("u1");
  clearPhotoStore();
});

describe("opening a draft written by an older build (§20)", () => {
  it("restores the text and the photo, and surfaces none of the retired AI metadata", async () => {
    const id = stashPhotoFile(new File([new Uint8Array([1, 2, 3])], "backpack.jpg", { type: "image/jpeg" }));
    seedLegacyDraft(id);

    render(<CreateReport />);
    await act(async () => {});

    // What the person typed comes back.
    const title = screen.getByLabelText(/what did you find\?/i) as HTMLInputElement;
    expect(title.value).toBe("Black backpack");
    expect(screen.getByTestId("category-trigger").textContent).toContain("Bags & Wallets");
    expect((screen.getByLabelText(/approximate location/i) as HTMLInputElement).value).toBe("Library steps");
    expect(document.querySelector('[contenteditable="true"]')?.textContent).toContain("blue tag on the zip");
    // …and so does the photo.
    expect(screen.getAllByTestId("report-photo-slide")).toHaveLength(1);

    // Nothing from the retired AI metadata is on screen — not a value, not a name.
    const screenText = document.body.textContent ?? "";
    for (const retired of MUST_NOT_APPEAR) {
      expect(screenText, `${retired} was surfaced`).not.toContain(retired);
    }
  });

  it("leaves the restored draft editable", async () => {
    const id = stashPhotoFile(new File([new Uint8Array([1, 2, 3])], "backpack.jpg", { type: "image/jpeg" }));
    seedLegacyDraft(id);

    render(<CreateReport />);
    await act(async () => {});

    const title = screen.getByLabelText(/what did you find\?/i) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Black backpack (blue tag)" } });
    expect(title.value).toBe("Black backpack (blue tag)");
    // The rest of the restore is still intact.
    expect(screen.getAllByTestId("report-photo-slide")).toHaveLength(1);
  });

  it("opens a draft whose retired metadata is the only thing in it, without inventing content", async () => {
    // A draft with no text and no photos is not worth restoring, but it must not
    // crash or pre-fill anything from the metadata beside it.
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ vlmSummary: "a red umbrella", suggestedCategory: "Other", confidence: 0.5 }),
    );

    render(<CreateReport />);
    await act(async () => {});

    const title = screen.getByLabelText(/what did you lose\?/i) as HTMLInputElement;
    expect(title.value).toBe("");
    expect(screen.queryAllByTestId("report-photo-slide")).toHaveLength(0);
    const screenText = document.body.textContent ?? "";
    expect(screenText).not.toContain("a red umbrella");
    expect(screenText).not.toContain("vlmSummary");
  });
});
