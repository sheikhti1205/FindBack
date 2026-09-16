// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { bridge } = vi.hoisted(() => ({ bridge: { getCapabilities: vi.fn(), getSettings: vi.fn(), setMode: vi.fn(), getModelStates: vi.fn(), downloadModel: vi.fn(), cancelDownload: vi.fn(), deleteModel: vi.fn(), runGpuSelfTest: vi.fn(), onDownloadProgress: vi.fn(), onModelStateChange: vi.fn() } }));
vi.mock("../services/vlmPlugin", () => ({ getVlmBridge: () => bridge }));

import { OfflineAi } from "./OfflineAi";

const capabilities = {
  abi: "arm64-v8a",
  androidVersion: "14",
  apiLevel: 34,
  hardware: "pixel",
  deviceCategory: "physical" as const,
  gpuVendor: "Qualcomm",
  gpuRenderer: "Adreno 730",
  memoryClassMb: 256,
  freeAppStorageMb: 1024,
  gpuRuntimePresent: true,
  runtimeVersion: "0.16.0",
};

afterEach(cleanup);

describe("OfflineAi", () => {
  it("discloses the exact download size and requires an explicit confirmation", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<OfflineAi />);
    expect(await screen.findByText(/360\.8 MB/)).toBeTruthy();
    bridge.downloadModel.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: /download smolvlm2 500m/i }));
    expect(bridge.downloadModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^confirm download$/i }));
    await waitFor(() => expect(bridge.downloadModel).toHaveBeenCalledWith("smolvlm2-500m"));
  });

  it("shows the runtime-specific reason instead of pretending the 256M model is ready", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm-256m", state: "GPU_UNAVAILABLE", error: "GPU runtime lacks the required delegate" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<OfflineAi />);
    expect(await screen.findByText(/GPU runtime lacks the required delegate/i)).toBeTruthy();
    expect(screen.queryByText(/ready/i)).toBeNull();
  });

  it("installs both models sequentially with one confirmation", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([
      { id: "smolvlm2-500m", state: "NOT_INSTALLED" },
      { id: "smolvlm-256m", state: "NOT_INSTALLED" },
    ]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.downloadModel.mockResolvedValue(undefined);
    render(<OfflineAi />);
    fireEvent.click(await screen.findByRole("button", { name: /install both/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm download$/i }));
    await waitFor(() => expect(bridge.downloadModel).toHaveBeenNthCalledWith(2, "smolvlm-256m"));
  });
});
