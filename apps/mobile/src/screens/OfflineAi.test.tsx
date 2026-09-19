// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const { bridge, photo } = vi.hoisted(() => ({
  bridge: { getCapabilities: vi.fn(), getSettings: vi.fn(), setMode: vi.fn(), getModelStates: vi.fn(), downloadModel: vi.fn(), waitForSettled: vi.fn(), pauseDownload: vi.fn(), resumeDownload: vi.fn(), repairModel: vi.fn(), cancelDownload: vi.fn(), deleteModel: vi.fn(), runGpuSelfTest: vi.fn(), cancelInference: vi.fn().mockResolvedValue(undefined), onDownloadProgress: vi.fn(), onModelStateChange: vi.fn() },
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

  it("does not expose the 256M model or the FAST mode (no report runtime)", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([
      { id: "smolvlm2-500m", state: "NOT_INSTALLED" },
      { id: "smolvlm-256m", state: "NOT_INSTALLED" },
    ]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    await screen.findByRole("heading", { name: /SmolVLM2 500M/ });
    expect(screen.queryByText(/256M/)).toBeNull();
    expect(screen.queryByRole("radio", { name: "FAST" })).toBeNull();
    expect(screen.queryByRole("button", { name: /install both/i })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: /inference mode/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: "AUTO" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "QUALITY" })).toBeNull();
  });

  it("has no AUTO/QUALITY inference selector and never calls setMode", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "FAST" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    await screen.findByRole("heading", { name: /SmolVLM2 500M/ });
    expect(screen.queryByRole("radio", { name: "AUTO" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "QUALITY" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "FAST" })).toBeNull();
    expect(bridge.setMode).not.toHaveBeenCalled();
    // The network policy control stays available.
    expect(screen.getByRole("radiogroup", { name: /download network/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Wi-Fi only" })).toBeTruthy();
  });

  it("requires the native policy (model + headroom), not size x 1.2", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    // 360.8 MB + max(256 MiB, 25%) = 616.8 MB.
    expect(await screen.findByText(/needs 616\.8 mb free/i)).toBeTruthy();
    // Native requiredBytes wins when reported.
    expect(screen.queryByText(/433|432/)).toBeNull();
  });

  it("uses native requiredBytes when the plugin reports it", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([
      { id: "smolvlm2-500m", state: "NOT_INSTALLED", requiredBytes: 700 * 1024 * 1024 },
    ]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    expect(await screen.findByText(/needs 700 mb free/i)).toBeTruthy();
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

  it("keeps revision hashes out of the visible row so they cannot overflow into the buttons", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    const { container } = render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    await screen.findAllByText(/technical details/i);
    const hash = "dad030b6e56756201d670cfb4d042736a2ce3a5c";
    // Still available, but only inside the collapsed disclosure.
    expect(container.textContent).toContain(hash);
    const leaked = Array.from(container.querySelectorAll("*")).filter((el) => {
      if (el.closest("details")) return false;
      return Array.from(el.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes(hash),
      );
    });
    expect(leaked).toEqual([]);
    // And where it does appear it is allowed to break, never forced to one line.
    const hashNode = Array.from(container.querySelectorAll("*")).find((el) =>
      el.textContent?.includes(hash) && el.className?.includes("break-all"),
    );
    expect(hashNode).toBeTruthy();
  });

  it("translates native error codes into plain language instead of raw enum strings", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([
      { id: "smolvlm2-500m", state: "GPU_UNAVAILABLE", error: "GPU_UNAVAILABLE_ON_CURRENT_RUNTIME" },
    ]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    expect(await screen.findByText(/won't fall back to the CPU/i)).toBeTruthy();
    expect(screen.queryByText("GPU_UNAVAILABLE_ON_CURRENT_RUNTIME")).toBeNull();
  });

  it("wraps the confirm dialog actions so a long label cannot push the dialog off-screen", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /download smolvlm2 500m/i }));
    const confirm = screen.getByRole("button", { name: /^confirm download$/i });
    expect(confirm.parentElement?.className).toContain("flex-wrap");
  });

  it("offers the 500M self-test without gating on the delegate class (W5 #26)", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.toNativeImageUri.mockReturnValue("content://self-test");
    bridge.getCapabilities.mockResolvedValue({ ...capabilities, gpuDelegateClassPresent: false });
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    await screen.findByText(/installed — gpu test required/i);
    expect(screen.getByRole("button", { name: /run gpu self-test \(camera\)/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /run gpu self-test \(gallery\)/i })).toBeTruthy();
  });

  it("surfaces a friendly error when a model action rejects (WP10a)", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "CORRUPT" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.repairModel.mockRejectedValue(new Error("Repair failed: disk busy"));
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /repair smolvlm2/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Repair failed: disk busy");
  });

  it("hides GPU self-test when native photo capture is unavailable (WP10)", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(false);
    try {
      bridge.getCapabilities.mockResolvedValue({ ...capabilities, gpuDelegateClassPresent: true });
      bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
      bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
      bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
      bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
      render(<MemoryRouter><OfflineAi /></MemoryRouter>);
      await screen.findByText(/installed — gpu test required/i);
      expect(screen.queryByRole("button", { name: /run gpu self-test \(camera\)/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /run gpu self-test \(gallery\)/i })).toBeNull();
    } finally {
      photo.isNativeCameraAvailable.mockReturnValue(true);
    }
  });

  it("disables Download with unknown storage when capabilities fail (W5 #21)", async () => {
    bridge.getCapabilities.mockRejectedValue(new Error("process dead"));
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: /SmolVLM2 500M/ })).toBeTruthy();
    expect(await screen.findByText(/checking storage/i)).toBeTruthy();
    const download = screen.getByRole("button", { name: /download smolvlm2 500m/i });
    expect((download as HTMLButtonElement).disabled).toBe(true);
  });

  it("still renders NOT_INSTALLED rows when model states fail (WP10 #20)", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getModelStates.mockRejectedValue(new Error("process dead"));
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: /SmolVLM2 500M/ })).toBeTruthy();
    expect(await screen.findByText(/not installed/i)).toBeTruthy();
  });

  it("cancels inference before closing a running self-test (W5 #2)", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.takePhoto.mockResolvedValue({ nativeUri: "content://photo", webPath: "content://photo", format: "jpg" });
    photo.toNativeImageUri.mockReturnValue("content://photo");
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.cancelInference.mockClear();
    bridge.cancelInference.mockResolvedValue(undefined);
    bridge.runGpuSelfTest.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /run gpu self-test \(camera\)/i }));
    expect(await screen.findByText(/running gpu self-test/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    await waitFor(() => expect(bridge.cancelInference).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/running gpu self-test/i)).toBeNull();
  });

  it("titles a bad photo without claiming GPU unavailable (W5 #25)", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.takePhoto.mockResolvedValue({ nativeUri: "content://photo", webPath: "content://photo", format: "jpg" });
    photo.toNativeImageUri.mockReturnValue("content://photo");
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.runGpuSelfTest.mockResolvedValue({ state: "GPU_UNAVAILABLE", error: "decode failed", failure: "INPUT_ERROR" });
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /run gpu self-test \(camera\)/i }));
    expect(await screen.findByText(/photo couldn't be read/i)).toBeTruthy();
    expect(screen.queryByText(/^gpu unavailable$/i)).toBeNull();
  });

  it("titles runtime failures and missing models distinctly (W5 #25)", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.takePhoto.mockResolvedValue({ nativeUri: "content://photo", webPath: "content://photo", format: "jpg" });
    photo.toNativeImageUri.mockReturnValue("content://photo");
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.runGpuSelfTest.mockResolvedValue({ state: "ERROR", error: "boom", failure: "MODEL_RUNTIME_ERROR" });
    const { unmount } = render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /run gpu self-test \(camera\)/i }));
    expect(await screen.findByText(/model runtime failed/i)).toBeTruthy();
    unmount();

    bridge.runGpuSelfTest.mockResolvedValue({ state: "MODEL_MISSING", error: "Model not installed" });
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /run gpu self-test \(camera\)/i }));
    expect(await screen.findByText(/gpu test unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/model runtime failed/i)).toBeNull();
  });

  it("keeps every active transfer off the Download button (W5 #20)", async () => {
    const active = ["QUEUED", "WAITING_FOR_NETWORK", "WAITING_FOR_WIFI", "DOWNLOADING", "PAUSING", "VERIFYING_CHUNK", "VERIFYING_HASH", "VERIFYING_FILE", "REPAIRING"];
    for (const state of active) {
      bridge.getCapabilities.mockResolvedValue(capabilities);
      bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state }]);
      bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
      bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
      const { unmount } = render(<MemoryRouter><OfflineAi /></MemoryRouter>);
      await screen.findByRole("heading", { name: /SmolVLM2 500M/ });
      expect(screen.queryByRole("button", { name: /download smolvlm2 500m/i })).toBeNull();
      expect(screen.getByRole("button", { name: /cancel smolvlm2/i })).toBeTruthy();
      unmount();
    }
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "GPU_SELF_TESTING" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    await screen.findByRole("heading", { name: /SmolVLM2 500M/ });
    expect(screen.queryByRole("button", { name: /download smolvlm2 500m/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /pause smolvlm2/i })).toBeNull();
  });

  it("confirms with both download size and required free storage (W5 #22)", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED", sizeBytes: 360822960, requiredBytes: 700 * 1024 * 1024 }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.downloadModel.mockResolvedValue(undefined);
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /download smolvlm2 500m/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/download size/i);
    expect(dialog.textContent).toMatch(/required free space/i);
    expect(dialog.textContent).toMatch(/700 mb/i);
    expect(dialog.textContent).not.toMatch(/this will download 700/i);
  });

  it("surfaces scheduling rejection on confirm via the alert (W5 #23)", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.downloadModel.mockRejectedValue(new Error("Scheduling failed: busy"));
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /download smolvlm2 500m/i }));
    fireEvent.click(screen.getByRole("button", { name: /^confirm download$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Scheduling failed: busy");
  });

  it("keeps photo cancellation quiet but shows real capture failures (W5 #23)", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.toNativeImageUri.mockReturnValue("content://photo");
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    photo.takePhoto.mockRejectedValueOnce(new Error("User cancelled"));
    const { unmount } = render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /run gpu self-test \(camera\)/i }));
    await waitFor(() => expect(photo.takePhoto).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();

    photo.takePhoto.mockRejectedValueOnce(new Error("Camera failed: disk busy"));
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /run gpu self-test \(camera\)/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Camera failed: disk busy");
  });
});
