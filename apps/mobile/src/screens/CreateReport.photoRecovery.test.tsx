// @vitest-environment jsdom
/**
 * §20: a restore can fail in ways no per-photo affordance can describe — a
 * hostile draft, a dead bridge, a registry that throws. The mount restore was
 * the one unguarded failure path in the form: it had `try`/`finally` but no
 * `catch`, and `onSubmit` awaited its promise outside its own `try`, so a
 * rejection left `submitting` stuck true and the screen gated with no error, no
 * retry and no way to remove the photos. What has to hold now: the text still
 * comes back, the unrecoverable slots are named with actions, and a restore
 * with nothing outstanding leaves the form usable.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { reviveMock, photo, nativeMedia } = vi.hoisted(() => ({
  reviveMock: vi.fn(),
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
vi.mock("../services/photo", () => photo);
vi.mock("../services/media/nativeMedia", () => ({
  chooseNativeImage: nativeMedia.chooseNativeImage,
  chooseNativeImages: nativeMedia.chooseNativeImages,
  importNativeImageUri: nativeMedia.importNativeImageUri,
  importedImageToFile: (item: { fileName?: string; derivative: { bytes: Uint8Array; mimeType: string } }) =>
    new File([item.derivative.bytes.slice()], item.fileName || "photo.jpg", { type: item.derivative.mimeType }),
}));
// Only the revive step is replaced; the rest of the store stays real so the
// draft's own photo ids are the store's business.
vi.mock("../services/photoStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/photoStore")>();
  return { ...actual, reviveNativePhotos: (...args: unknown[]) => reviveMock(...args) };
});

import { CreateReport } from "./CreateReport";
import { clearDraft } from "../services/reportDraft";
import { clearPhotoStore } from "../services/photoStore";

const DRAFT_KEY = "findback:reportDraft:v1:u1";

afterEach(() => {
  cleanup();
  localStorage.removeItem(DRAFT_KEY);
  clearDraft("u1");
  clearPhotoStore();
  reviveMock.mockReset();
});

describe("a mount restore that fails outright (§20)", () => {
  it("names the photos it could not recover instead of wedging the form", async () => {
    reviveMock.mockRejectedValue(new Error("revive bridge failed"));
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        type: "FOUND",
        title: "Phone",
        photoIds: ["p1"],
        photoRefs: [{ id: "p1", nativeUri: "content://gone" }],
      }),
    );

    render(<CreateReport />);
    await act(async () => {});

    // The text survived…
    expect((screen.getByLabelText(/what did you find\?/i) as HTMLInputElement).value).toBe("Phone");
    // …and the unrecoverable slot is named with actions, not left silent.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Saved photos could not be recovered");
    expect(alert.textContent).toContain("Photo 1");
    expect(screen.getByRole("button", { name: /retry recovery/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove unavailable and continue/i })).toBeTruthy();
    // Publish stays gated — but visibly, with the way out on screen.
    expect((screen.getByRole("button", { name: /publish/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the form when a failed restore has nothing outstanding to recover", async () => {
    reviveMock.mockRejectedValue(new Error("revive bridge failed"));
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: "Phone" }));

    render(<CreateReport />);
    await act(async () => {});

    expect((screen.getByLabelText(/what did you lose\?/i) as HTMLInputElement).value).toBe("Phone");
    // Nothing was asked for, so nothing is withheld: no alert, publish reachable.
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: /publish/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
