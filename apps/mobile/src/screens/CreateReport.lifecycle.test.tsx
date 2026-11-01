// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publish, account, nativeMedia, navigate } = vi.hoisted(() => ({
  publish: vi.fn(),
  account: { current: "u1" },
  navigate: vi.fn(),
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
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: account.current, username: "tester" } }) }));
vi.mock("../services/posts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/posts")>()),
  publishReport: (...args: unknown[]) => publish(...args),
}));
vi.mock("../services/photo", () => ({
  isNativeCameraAvailable: () => false,
  takePhoto: vi.fn(),
  chooseFromGallery: vi.fn(),
  photoToFile: vi.fn(),
  normalizeForUpload: vi.fn(async (file: File) => file),
  toNativeImageUri: vi.fn(),
}));
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
import { clearDraft, loadDraft, saveDraft } from "../services/reportDraft";
import { clearPhotoStore } from "../services/photoStore";
import { todayInputValue } from "../utils/dates";
import { PublishOutcomeUncertainError } from "../services/publishOutcome";

import { categoryValue } from "../test-utils/reportCategory";
function fixture(title: string) {
  return {
    type: "LOST" as const,
    title,
    description: "A black bag near the north gate entrance",
    category: "Bags & Wallets" as const,
    eventDate: todayInputValue(),
    location: { label: "North gate", latitude: null, longitude: null },
    youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
  };
}

beforeEach(() => {
  account.current = "u1";
  publish.mockReset();
  navigate.mockReset();
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

describe("Report publication lifecycle", () => {
  it("clears the mounted form and durable draft only after a confirmed post id", async () => {
    saveDraft(fixture("Old bag"), "u1");
    let confirm!: (id: string) => void;
    publish.mockReturnValue(new Promise<string>((resolve) => { confirm = resolve; }));
    const view = render(<CreateReport />);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("Old bag");
    expect(loadDraft("u1")?.title).toBe("Old bag");

    confirm("confirmed-post");
    await waitFor(() => expect(loadDraft("u1")).toBeNull());
    view.rerender(<CreateReport />);
    expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Description").textContent).toBe("");
    expect(categoryValue()).toBe("");
    expect((screen.getByLabelText(/approximate location/i) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/youtube link/i) as HTMLInputElement).value).toBe("");
    expect(loadDraft("u1")?.title).not.toBe("Old bag");
  });

  it("never shows account A's mounted draft after switching to account B", async () => {
    saveDraft(fixture("Alice's bag"), "u1");
    saveDraft(fixture("Bob's bag"), "u2");
    const view = render(<CreateReport />);
    expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("Alice's bag");
    account.current = "u2";
    view.rerender(<CreateReport />);
    await waitFor(() =>
      expect((screen.getByLabelText(/what did you lose/i) as HTMLInputElement).value).toBe("Bob's bag"),
    );
    expect(loadDraft("u1")?.title).toBe("Alice's bag");
  });

  it("keeps a newer draft when an abandoned publish settles after re-entry", async () => {
    // Repro A: leave Create while the publish is pending, come back and start a
    // newer draft. The obsolete continuation must not clear the newer draft or
    // navigate away from it.
    saveDraft(fixture("Old bag"), "u1");
    let confirm!: (id: string) => void;
    publish.mockReturnValue(new Promise<string>((resolve) => { confirm = resolve; }));
    const first = render(<CreateReport />);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    first.unmount();
    saveDraft(fixture("New bag"), "u1");
    await act(async () => { confirm("confirmed-post"); await Promise.resolve(); });
    expect(loadDraft("u1")?.title).toBe("New bag");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("binds the irreversible publish to the account the form was filled in", async () => {
    // The create RPC uses the SDK's current session. The captured account must
    // travel with the request so a session swap cannot publish A's draft as B.
    saveDraft(fixture("Old bag"), "u1");
    publish.mockResolvedValue("confirmed-post");
    render(<CreateReport />);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0]![0]).toMatchObject({ expectedAccountId: "u1" });
  });

  it("blocks a second publish after an uncertain response, including on remount", async () => {
    saveDraft(fixture("Old bag"), "u1");
    publish.mockRejectedValue(new PublishOutcomeUncertainError());
    const view = render(<CreateReport />);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    await screen.findByText(/publication outcome is uncertain/i);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(loadDraft("u1")?.title).toBe("Old bag");

    view.unmount();
    render(<CreateReport />);
    fireEvent.submit(screen.getByRole("button", { name: /publish/i }).closest("form")!);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
