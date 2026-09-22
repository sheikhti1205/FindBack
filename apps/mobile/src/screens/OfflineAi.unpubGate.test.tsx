// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const { bridge, photo } = vi.hoisted(() => ({
  bridge: { getCapabilities: vi.fn(), getSettings: vi.fn(), setMode: vi.fn(), setCpuFallback: vi.fn(), getModelStates: vi.fn(), downloadModel: vi.fn(), waitForSettled: vi.fn(), pauseDownload: vi.fn(), resumeDownload: vi.fn(), repairModel: vi.fn(), cancelDownload: vi.fn(), deleteModel: vi.fn(), runGpuSelfTest: vi.fn(), cancelInference: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined), onDownloadProgress: vi.fn(), onModelStateChange: vi.fn() },
  photo: {
    isNativeCameraAvailable: vi.fn(() => true),
    takePhoto: vi.fn(),
    chooseFromGallery: vi.fn(),
    toNativeImageUri: vi.fn(),
    isCancellation: (err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      return code === "TakePhotoCancelled" || code === "ChooseMediaCancelled";
    },
  },
}));
vi.mock("../services/vlmPlugin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/vlmPlugin")>();
  return { ...actual, getVlmBridge: () => bridge };
});
vi.mock("../services/photo", () => photo);

// No shippedCatalogue mock here: this suite proves the UNPUBLISHED gate
// against the real shipped catalogue.
import { OfflineAi } from "./OfflineAi";

const capabilities = {
  abi: "arm64-v8a",
  androidVersion: "14",
  apiLevel: 34,
  hardware: "mt6895",
  deviceCategory: "physical" as const,
  gpuVendor: "ARM",
  gpuRenderer: "Mali-G610 MC6",
  memoryClassMb: 256,
  freeAppStorageMb: 1024,
  gpuDelegateClassPresent: true,
  runtimeVersion: "0.16.0",
};

function mockQuietBridge() {
  bridge.getCapabilities.mockResolvedValue(capabilities);
  bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
  bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
  bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
}

afterEach(cleanup);

describe("OfflineAi unpublished distribution gate", () => {
  it("offers no network download while UNPUBLISHED and states it plainly", async () => {
    mockQuietBridge();
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.downloadModel.mockClear();
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const card = await screen.findByRole("listitem", { name: "SmolVLM2 500M (LiteRT, int4)" });
    const scoped = within(card);
    expect(scoped.getByText("Package prepared but not published in this build.")).toBeTruthy();
    expect(scoped.getByText("Library status: Unpublished")).toBeTruthy();
    expect(scoped.queryByRole("button", { name: /download/i })).toBeNull();
    expect(scoped.queryByText(/verification running/i)).toBeNull();
    expect(bridge.downloadModel).not.toHaveBeenCalled();
  });

  it("keeps offline import/export available while UNPUBLISHED", async () => {
    mockQuietBridge();
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const card = await screen.findByRole("listitem", { name: "SmolVLM2 500M (LiteRT, int4)" });
    const scoped = within(card);
    expect(scoped.getByRole("button", { name: /import smolvlm2 500m/i })).toBeTruthy();
    expect(scoped.getByRole("button", { name: /export smolvlm2 500m/i })).toBeTruthy();
  });

  it("keeps runtime absence ahead of publication for entries with no wired runtime", async () => {
    mockQuietBridge();
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const qwen = await screen.findByRole("listitem", { name: "Qwen3 0.6B (LiteRT, dynamic int4)" });
    expect(within(qwen).getByText(/no on-device runtime is wired/i)).toBeTruthy();
    expect(within(qwen).getByText("Library status: No executable runtime in this build")).toBeTruthy();
    expect(within(qwen).queryByRole("button", { name: /download/i })).toBeNull();
  });

  it("leaves installed-state semantics untouched while UNPUBLISHED", async () => {
    mockQuietBridge();
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const card = await screen.findByRole("listitem", { name: "SmolVLM2 500M (LiteRT, int4)" });
    const scoped = within(card);
    expect(scoped.getByText("Library status: Installed")).toBeTruthy();
    expect(scoped.getByRole("button", { name: /verify .* accelerator/i })).toBeTruthy();
    expect(scoped.queryByRole("button", { name: /download/i })).toBeNull();
  });
});
