// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const { bridge, photo } = vi.hoisted(() => ({
  bridge: {
    getCapabilities: vi.fn(),
    getSettings: vi.fn(),
    getModelStates: vi.fn(),
    downloadModel: vi.fn(),
    pauseDownload: vi.fn(),
    resumeDownload: vi.fn(),
    repairModel: vi.fn(),
    cancelDownload: vi.fn(),
    deleteModel: vi.fn(),
    runGpuSelfTest: vi.fn(),
    cancelInference: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    onDownloadProgress: vi.fn(),
    onModelStateChange: vi.fn(),
  },
  photo: {
    isNativeCameraAvailable: vi.fn(() => true),
    takePhoto: vi.fn(),
    chooseFromGallery: vi.fn(),
    toNativeImageUri: vi.fn(),
    isCancellation: () => false,
  },
}));
vi.mock("../services/vlmPlugin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/vlmPlugin")>();
  return { ...actual, getVlmBridge: () => bridge, getNativePackageHost: () => null };
});
vi.mock("../services/photo", () => photo);

import { OfflineAi } from "./OfflineAi";

const baseCapabilities = {
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

function mockQuiet() {
  bridge.getCapabilities.mockResolvedValue(baseCapabilities);
  bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
  bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
  bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
}

afterEach(cleanup);

describe("OfflineAi workset 3 (role-aware library, RAM, errors)", () => {
  it("reads free RAM from the native availableRamMb capability", async () => {
    bridge.getCapabilities.mockResolvedValue({
      ...baseCapabilities,
      availableRamMb: 2048,
    });
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([
      { id: "smolvlm2-500m", state: "NOT_INSTALLED" },
    ]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(
      <MemoryRouter>
        <OfflineAi />
      </MemoryRouter>,
    );
    const card = await screen.findByRole("listitem", {
      name: "SmolVLM2 500M (LiteRT, int4)",
    });
    expect(within(card).getByText("Your device now: ~2.0 GB available")).toBeTruthy();
  });

  it("shows Unknown only when neither the seam nor native RAM reports", async () => {
    mockQuiet();
    bridge.getModelStates.mockResolvedValue([
      { id: "smolvlm2-500m", state: "NOT_INSTALLED" },
    ]);
    render(
      <MemoryRouter>
        <OfflineAi />
      </MemoryRouter>,
    );
    const card = await screen.findByRole("listitem", {
      name: "SmolVLM2 500M (LiteRT, int4)",
    });
    expect(within(card).getByText("Your device now: unknown")).toBeTruthy();
  });

  it("offers Import (not Download) for the qualified Qwen entry while UNPUBLISHED", async () => {
    mockQuiet();
    bridge.getModelStates.mockResolvedValue([
      { id: "smolvlm2-500m", state: "NOT_INSTALLED" },
    ]);
    render(
      <MemoryRouter>
        <OfflineAi />
      </MemoryRouter>,
    );
    const qwen = await screen.findByRole("listitem", {
      name: "Qwen3 0.6B (LiteRT, dynamic int4)",
    });
    const scoped = within(qwen);
    expect(scoped.queryByRole("button", { name: /download/i })).toBeNull();
    expect(
      scoped.getByRole("button", { name: /import qwen3 0.6b/i }),
    ).toBeTruthy();
    expect(
      scoped.getByRole("button", { name: /export qwen3 0.6b/i }),
    ).toBeTruthy();
  });

  it("never leaks raw READY_GPU/AUTO codes in action errors", async () => {
    mockQuiet();
    bridge.getModelStates.mockResolvedValue([
      { id: "smolvlm2-500m", state: "CORRUPT" },
    ]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.repairModel.mockRejectedValue(new Error("READY_GPU"));
    render(
      <MemoryRouter>
        <OfflineAi />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /repair smolvlm2/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("READY_GPU");
    expect(alert.textContent).not.toMatch(/_/);
  });
});
