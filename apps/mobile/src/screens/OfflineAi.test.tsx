// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const { bridge } = vi.hoisted(() => ({ bridge: { getCapabilities: vi.fn(), getSettings: vi.fn(), setMode: vi.fn(), getModelStates: vi.fn(), downloadModel: vi.fn(), waitForSettled: vi.fn(), pauseDownload: vi.fn(), resumeDownload: vi.fn(), repairModel: vi.fn(), cancelDownload: vi.fn(), deleteModel: vi.fn(), runGpuSelfTest: vi.fn(), onDownloadProgress: vi.fn(), onModelStateChange: vi.fn() } }));
vi.mock("../services/vlmPlugin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/vlmPlugin")>();
  return { ...actual, getVlmBridge: () => bridge };
});

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
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
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
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    expect(await screen.findByText(/GPU runtime lacks the required delegate/i)).toBeTruthy();
    expect(screen.queryByText(/ready/i)).toBeNull();
  });

  it("installs both models sequentially, waiting for the first to settle", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([
      { id: "smolvlm2-500m", state: "NOT_INSTALLED" },
      { id: "smolvlm-256m", state: "NOT_INSTALLED" },
    ]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    // First model settles only after the test releases it, proving the second
    // transfer is not scheduled while the first is still running.
    let releaseFirst: (v: { id: "smolvlm2-500m"; state: "INSTALLED_UNVERIFIED" }) => void = () => {};
    const firstSettled = new Promise<{ id: "smolvlm2-500m"; state: "INSTALLED_UNVERIFIED" }>((resolve) => {
      releaseFirst = resolve;
    });
    bridge.downloadModel.mockResolvedValue(undefined);
    bridge.waitForSettled.mockReturnValue(firstSettled);
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /install both/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm download$/i }));
    await waitFor(() => expect(bridge.downloadModel).toHaveBeenCalledWith("smolvlm2-500m"));
    await waitFor(() => expect(bridge.waitForSettled).toHaveBeenCalledWith("smolvlm2-500m"));
    expect(bridge.downloadModel).not.toHaveBeenCalledWith("smolvlm-256m");
    releaseFirst({ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" });
    await waitFor(() => expect(bridge.downloadModel).toHaveBeenCalledWith("smolvlm-256m"));
  });

  it("does not start the second install when the first does not install", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([
      { id: "smolvlm2-500m", state: "NOT_INSTALLED" },
      { id: "smolvlm-256m", state: "NOT_INSTALLED" },
    ]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.downloadModel.mockResolvedValue(undefined);
    bridge.waitForSettled.mockResolvedValue({ id: "smolvlm2-500m", state: "DOWNLOAD_FAILED" });
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /install both/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm download$/i }));
    await waitFor(() => expect(bridge.waitForSettled).toHaveBeenCalledWith("smolvlm2-500m"));
    expect(bridge.downloadModel).not.toHaveBeenCalledWith("smolvlm-256m");
  });

  it("keeps Cancel enabled even when free space is low", async () => {
    bridge.getCapabilities.mockResolvedValue({ ...capabilities, freeAppStorageMb: 0 });
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "DOWNLOADING" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const cancel = await screen.findByRole("button", { name: /cancel smolvlm2/i });
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers Repair that keeps verified chunks on corrupt data", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "CORRUPT" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.repairModel.mockResolvedValue(undefined);
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    expect(await screen.findByText(/verified chunks will be kept/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /repair smolvlm2/i }));
    await waitFor(() => expect(bridge.repairModel).toHaveBeenCalledWith("smolvlm2-500m"));
  });

  it("closes the confirm dialog immediately so progress and cancel stay visible", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    // Never-resolving download: the dialog must still close right away.
    bridge.downloadModel.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /download smolvlm2 500m/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm download$/i }));
    await waitFor(() => expect(bridge.downloadModel).toHaveBeenCalledWith("smolvlm2-500m"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the real pinned revision in technical details, never a placeholder", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    const { container } = render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    expect((await screen.findAllByText(/technical details/i)).length).toBeGreaterThan(0);
    expect(container.textContent).toMatch(/dad030b6e56756201d670cfb4d042736a2ce3a5c/);
    expect(container.textContent).not.toMatch(/a1b2c3d4/);
  });

  it("pauses an in-flight download without discarding progress", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "DOWNLOADING" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.pauseDownload.mockResolvedValue(undefined);
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /pause smolvlm2/i }));
    await waitFor(() => expect(bridge.pauseDownload).toHaveBeenCalledWith("smolvlm2-500m"));
  });
});
