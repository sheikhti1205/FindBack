// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    expect(await screen.findByText(/344\.1 MB download/)).toBeTruthy();
    bridge.downloadModel.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: /download smolvlm2 500m/i }));
    expect(bridge.downloadModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^confirm download$/i }));
    await waitFor(() => expect(bridge.downloadModel).toHaveBeenCalledWith("smolvlm2-500m"));
  });

  it("shows the 256M model as experimental with no download or verify action", async () => {
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
    expect(await screen.findByRole("heading", { name: /SmolVLM 256M/ })).toBeTruthy();
    expect(screen.getByText(/not available for report generation in this beta/i)).toBeTruthy();
    expect(screen.getByText(/current graph incompatible/i)).toBeTruthy();
    // Fresh user: no download CTA and no storage management for the candidate.
    expect(screen.queryByRole("button", { name: /download smolvlm 256m/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete on-device data/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: "FAST" })).toBeNull();
    expect(screen.queryByRole("button", { name: /install both/i })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: /inference mode/i })).toBeNull();
    expect(screen.queryByRole("radio", { name: "AUTO" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "QUALITY" })).toBeNull();
  });

  it("manages already-installed 256M storage without offering download", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([
      { id: "smolvlm2-500m", state: "NOT_INSTALLED" },
      { id: "smolvlm-256m", state: "INSTALLED_UNVERIFIED", sizeBytes: 288229208 },
    ]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      render(<MemoryRouter><OfflineAi /></MemoryRouter>);
      expect(await screen.findByText(/on-device data: 274\.9 mb/i)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /download smolvlm 256m/i })).toBeNull();
      bridge.deleteModel.mockResolvedValue(undefined);
      fireEvent.click(screen.getByRole("button", { name: /delete on-device data/i }));
      await waitFor(() => expect(bridge.deleteModel).toHaveBeenCalledWith("smolvlm-256m"));
    } finally {
      confirmSpy.mockRestore();
    }
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

  it("offers the CPU compatibility switch and persists the choice", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO", allowCpuFallback: false });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const toggle = await screen.findByRole("switch", { name: /allow cpu compatibility mode/i });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    bridge.setCpuFallback.mockResolvedValue(undefined);
    fireEvent.click(toggle);
    await waitFor(() => expect(bridge.setCpuFallback).toHaveBeenCalledWith(true));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("defaults CPU compatibility to on when native omits the setting", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    // 360822960 B + max(256 MiB, 25%) = 629258416 B = 600.1 MB.
    expect(await screen.findByText(/needs 600\.1 mb free/i)).toBeTruthy();
    // Native requiredBytes wins when reported.
    expect(screen.queryByText(/433|432/)).toBeNull();
    // Omitted CPU setting defaults to on.
    expect(screen.getByRole("switch", { name: /allow cpu compatibility mode/i }).getAttribute("aria-checked")).toBe("true");
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
    expect(await screen.findByText(/may still run on cpu with an explicit on-screen notice/i)).toBeTruthy();
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

  it("offers one accelerator verification action with a source picker", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.takePhoto.mockResolvedValue({ nativeUri: "content://self-test", webPath: "content://self-test", format: "jpg" });
    photo.toNativeImageUri.mockReturnValue("content://self-test");
    bridge.getCapabilities.mockResolvedValue({ ...capabilities, gpuDelegateClassPresent: false });
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.runGpuSelfTest.mockResolvedValue({ state: "GPU_AVAILABLE" });
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    await screen.findByText(/installed — gpu test required/i);
    expect(screen.queryByRole("button", { name: /run gpu self-test/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /verify .* accelerator/i }));
    expect(screen.getByRole("group", { name: /verification source/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /use camera/i }));
    await waitFor(() => expect(photo.takePhoto).toHaveBeenCalled());
    await waitFor(() => expect(bridge.runGpuSelfTest).toHaveBeenCalledWith("smolvlm2-500m", "content://self-test"));
  });

  it("offers accelerator verification without gating on the delegate class", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.takePhoto.mockClear();
    photo.toNativeImageUri.mockReturnValue("content://self-test");
    bridge.getCapabilities.mockResolvedValue({ ...capabilities, gpuDelegateClassPresent: false });
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    await screen.findByText(/installed — gpu test required/i);
    fireEvent.click(screen.getByRole("button", { name: /verify .* accelerator/i }));
    expect(screen.getByRole("group", { name: /verification source/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByRole("group", { name: /verification source/i })).toBeNull();
    expect(photo.takePhoto).not.toHaveBeenCalled();
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
      expect(screen.queryByRole("button", { name: /verify .* accelerator/i })).toBeNull();
      expect(screen.queryByRole("group", { name: /verification source/i })).toBeNull();
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
    expect((await screen.findAllByText(/checking storage/i)).length).toBeGreaterThan(0);
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
    fireEvent.click(await screen.findByRole("button", { name: /verify .* accelerator/i }));
    fireEvent.click(screen.getByRole("button", { name: /use camera/i }));
    expect(await screen.findByText(/verifying accelerator/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^close$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^cancel test$/i }));
    await waitFor(() => expect(bridge.cancelInference).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/verifying accelerator/i)).toBeNull();
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
    fireEvent.click(await screen.findByRole("button", { name: /verify .* accelerator/i }));
    fireEvent.click(screen.getByRole("button", { name: /use camera/i }));
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
    fireEvent.click(await screen.findByRole("button", { name: /verify .* accelerator/i }));
    fireEvent.click(screen.getByRole("button", { name: /use camera/i }));
    expect(await screen.findByText(/model runtime failed/i)).toBeTruthy();
    unmount();

    bridge.runGpuSelfTest.mockResolvedValue({ state: "MODEL_MISSING", error: "Model not installed" });
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /verify .* accelerator/i }));
    fireEvent.click(screen.getByRole("button", { name: /use camera/i }));
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
    fireEvent.click(await screen.findByRole("button", { name: /verify .* accelerator/i }));
    fireEvent.click(screen.getByRole("button", { name: /use camera/i }));
    await waitFor(() => expect(photo.takePhoto).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();

    photo.takePhoto.mockRejectedValueOnce(new Error("Camera failed: disk busy"));
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /verify .* accelerator/i }));
    fireEvent.click(screen.getByRole("button", { name: /use camera/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Camera failed: disk busy");
  });

  it("verifies from gallery through the same accelerator action", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.chooseFromGallery.mockResolvedValue({ nativeUri: "content://gallery", webPath: "content://gallery", format: "jpg" });
    photo.toNativeImageUri.mockReturnValue("content://gallery");
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.runGpuSelfTest.mockResolvedValue({ state: "GPU_AVAILABLE" });
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /verify .* accelerator/i }));
    fireEvent.click(screen.getByRole("button", { name: /choose from gallery/i }));
    await waitFor(() => expect(photo.chooseFromGallery).toHaveBeenCalled());
    await waitFor(() => expect(bridge.runGpuSelfTest).toHaveBeenCalledWith("smolvlm2-500m", "content://gallery"));
    expect(await screen.findByText(/gpu available/i)).toBeTruthy();
  });

  it("shows Close only after verification finishes", async () => {
    photo.isNativeCameraAvailable.mockReturnValue(true);
    photo.takePhoto.mockResolvedValue({ nativeUri: "content://photo", webPath: "content://photo", format: "jpg" });
    photo.toNativeImageUri.mockReturnValue("content://photo");
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.runGpuSelfTest.mockResolvedValue({ state: "GPU_AVAILABLE" });
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /verify .* accelerator/i }));
    fireEvent.click(screen.getByRole("button", { name: /use camera/i }));
    expect(await screen.findByText(/gpu available/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^cancel test$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows the installed app version and build SHA for acceptance evidence", async () => {
    bridge.getCapabilities.mockResolvedValue({ ...capabilities, appVersion: "0.1.0", buildGitSha: "3524a8f2c48855000f1029ea9f6e6a610e93796b" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const build = await screen.findByTestId("build-info");
    expect(build.textContent).toContain("App 0.1.0");
    expect(build.textContent).toContain("Build 3524a8f2c488");
    expect(build.getAttribute("title")).toBe("3524a8f2c48855000f1029ea9f6e6a610e93796b");
  });

  it("stacks model actions and constrains dialogs for narrow viewports", async () => {    photo.isNativeCameraAvailable.mockReturnValue(true);
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    const { container } = render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const card = await screen.findByRole("listitem", { name: /smolvlm2 500m/i });
    expect(card.className).toContain("min-w-0");
    expect(card.className).toContain("overflow-x-hidden");
    const stack = card.firstElementChild as HTMLElement | null;
    expect(stack?.className).toContain("flex-col");
    expect(stack?.className).toContain("min-w-0");
    const download = screen.getByRole("button", { name: /download smolvlm2 500m/i });
    expect(download.className).toContain("w-full");
    expect(download.className).toContain("whitespace-normal");
    fireEvent.click(download);
    const dialog = await screen.findByRole("dialog");
    const panel = dialog.querySelector("div");
    expect(panel?.className).toContain("calc(100vw-2rem)");
    expect(panel?.className).toContain("overflow-y-auto");
    expect(container.querySelectorAll('[class*="yellow"], [class*="amber"]').length).toBe(0);
  });

  it("drives cards from the shipped catalogue with role, runtime, verification, and RAM figures", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const card = await screen.findByRole("listitem", { name: "SmolVLM2 500M (LiteRT, int4)" });
    const scoped = within(card);
    expect(scoped.getByText("report-from-photo")).toBeTruthy();
    expect(scoped.getAllByText("litert-lm").length).toBeGreaterThan(0);
    expect(scoped.getByText("Verified")).toBeTruthy();
    expect(scoped.getByText("Minimum free RAM ~1.5 GB")).toBeTruthy();
    expect(scoped.getByText("Recommended ~2.5 GB")).toBeTruthy();
    expect(scoped.getByText("Your device now: unknown")).toBeTruthy();
    expect(scoped.getByText("Conservative estimate")).toBeTruthy();
    // Verified entries carry no device caveat.
    expect(scoped.queryByText(/not verified on this device/i)).toBeNull();
  });

  it("warns verbatim on untested entries and never offers them for download without a runtime", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const qwen = await screen.findByRole("listitem", { name: "Qwen3 0.6B (LiteRT, dynamic int4)" });
    expect(within(qwen).getByText("Not verified on this device. May fail on devices with limited free memory.")).toBeTruthy();
    expect(within(qwen).queryByRole("button", { name: /download/i })).toBeNull();
    const vl = await screen.findByRole("listitem", { name: /LFM2\.5-VL 450M/ });
    expect(within(vl).queryByRole("button", { name: /download/i })).toBeNull();
    const gemma = await screen.findByRole("listitem", { name: /Gemma 3n/ });
    expect(within(gemma).queryByRole("button", { name: /download/i })).toBeNull();
    expect(within(gemma).queryByRole("button", { name: /import/i })).toBeNull();
    expect(within(gemma).queryByRole("button", { name: /export/i })).toBeNull();
  });

  it("states runtime absence plainly and offers no activation without a runtime", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const smol = await screen.findByRole("listitem", { name: "SmolVLM2 500M (LiteRT, int4)" });
    expect(within(smol).getByText("Library status: Available to download")).toBeTruthy();
    const qwen = await screen.findByRole("listitem", { name: "Qwen3 0.6B (LiteRT, dynamic int4)" });
    expect(within(qwen).getByText("Library status: No executable runtime in this build")).toBeTruthy();
    expect(within(qwen).queryByRole("button", { name: /set .* as active model/i })).toBeNull();
    const vl = await screen.findByRole("listitem", { name: /LFM2\.5-VL 450M/ });
    expect(within(vl).getByText("Library status: No executable runtime in this build")).toBeTruthy();
    expect(within(vl).queryByRole("button", { name: /set .* as active model/i })).toBeNull();
    const gemma = await screen.findByRole("listitem", { name: /Gemma 3n/ });
    expect(within(gemma).getByText("Library status: Catalog reference only")).toBeTruthy();
    expect(within(gemma).queryByRole("button", { name: /set .* as active model/i })).toBeNull();
  });

  it("gates a below-minimum download behind explicit acknowledgement", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.downloadModel.mockClear();
    bridge.downloadModel.mockResolvedValue(undefined);
    render(<MemoryRouter><OfflineAi availableFreeRamMb={512} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /download smolvlm2 500m/i }));
    expect(await screen.findByTestId("model-advanced-confirm-gate")).toBeTruthy();
    const confirm = screen.getByTestId("model-gate-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(bridge.downloadModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("model-gate-acknowledge"));
    await waitFor(() => expect((screen.getByTestId("model-gate-confirm") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("model-gate-confirm"));
    await waitFor(() => expect(bridge.downloadModel).toHaveBeenCalledWith("smolvlm2-500m"));
  });

  it("switches the resident model cancel → release → verify in order", async () => {
    window.localStorage.removeItem("findback:offline-ai:active-model");
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "READY_GPU" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    bridge.cancelInference.mockClear();
    bridge.release.mockClear();
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /set smolvlm2 500m.*as active model/i }));
    await waitFor(() => expect(screen.getByText("Active for analysis")).toBeTruthy());
    expect(bridge.cancelInference).toHaveBeenCalledTimes(1);
    expect(bridge.release).toHaveBeenCalledTimes(1);
    const cancelOrder = (bridge.cancelInference as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
    const releaseOrder = (bridge.release as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
    expect(cancelOrder).toBeLessThan(releaseOrder as number);
    expect(window.localStorage.getItem("findback:offline-ai:active-model")).toBe("smolvlm2-500m-litert-int4");
    // Active entries offer no second switch: no repeat cancel/release cycle.
    expect(screen.queryByRole("button", { name: /set smolvlm2 500m.*as active model/i })).toBeNull();
    expect(bridge.cancelInference).toHaveBeenCalledTimes(1);
    expect(bridge.release).toHaveBeenCalledTimes(1);
  });

  it("refuses to persist activation when the runtime never initialized", async () => {
    window.localStorage.removeItem("findback:offline-ai:active-model");
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /set smolvlm2 500m.*as active model/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/runtime is not ready/i);
    expect(screen.queryByText("Active for analysis")).toBeNull();
    expect(window.localStorage.getItem("findback:offline-ai:active-model")).toBeNull();
  });

  it("blocks activation below minimum without confirmation, with the gate reason", async () => {
    window.localStorage.removeItem("findback:offline-ai:active-model");
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi availableFreeRamMb={100} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /set smolvlm2 500m.*as active model/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/advanced confirmation required/i);
    expect(screen.queryByText("Active for analysis")).toBeNull();
  });

  it("refuses an import file that misses the shipped pin, and unpinned entries outright", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    const { container } = render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const card = await screen.findByRole("listitem", { name: "SmolVLM2 500M (LiteRT, int4)" });
    fireEvent.click(within(card).getByRole("button", { name: /import smolvlm2 500m/i }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const streamText = (text: string) => {
      const bytes = new TextEncoder().encode(text);
      const file = new File([text], "model.fbmodel");
      Object.defineProperty(file, "stream", {
        configurable: true,
        value: () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
      });
      return file;
    };
    fireEvent.change(input, { target: { files: [streamText("not-the-model")] } });
    expect(await within(card).findByText(/does not match the shipped catalogue pin/i)).toBeTruthy();

    const unpinned = await screen.findByRole("listitem", { name: "Qwen3 0.6B (LiteRT, mixed int4)" });
    fireEvent.click(within(unpinned).getByRole("button", { name: /import qwen3 0.6b/i }));
    fireEvent.change(input, { target: { files: [streamText("x")] } });
    expect(await within(unpinned).findByText(/no shipped hash pin/i)).toBeTruthy();
  });

  it("exports through the injected writer seam, and explains when no writer exists", async () => {
    const encoder = new TextEncoder();
    const written = new Map<string, Uint8Array[]>();
    const readerFor = () => ({
      files: [
        { path: "weights/model.litertlm", size: 4 },
        { path: "tokenizer/vocab.json", size: 2 },
      ],
      openRead: (path: string) => {
        const bytes = path.startsWith("weights/") ? new Uint8Array([1, 2, 3, 4]) : encoder.encode("{}");
        return (async function* () {
          yield bytes;
        })();
      },
    });
    const makePackageWriter = () => ({
      writeFile: async (_file: { path: string; method: "STORE" | "DEFLATE" }, chunks: AsyncIterable<Uint8Array>) => {
        const parts: Uint8Array[] = [];
        for await (const chunk of chunks) parts.push(chunk);
        written.set(_file.path, parts);
      },
    });
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi exportReaderFor={readerFor} makePackageWriter={makePackageWriter} /></MemoryRouter>);
    const card = await screen.findByRole("listitem", { name: "SmolVLM2 500M (LiteRT, int4)" });
    fireEvent.click(within(card).getByRole("button", { name: /export smolvlm2 500m/i }));
    expect(await within(card).findByText(/packaged 3 files for smolvlm2-500m-litert-int4/i)).toBeTruthy();
    expect(written.has("manifest.json")).toBe(true);
    expect(written.has("checksums.json")).toBe(true);
  });

  it("explains that export packaging runs in the platform installer when no writer is injected", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const card = await screen.findByRole("listitem", { name: "SmolVLM2 500M (LiteRT, int4)" });
    fireEvent.click(within(card).getByRole("button", { name: /export smolvlm2 500m/i }));
    expect(await within(card).findByText(/platform installer/i)).toBeTruthy();
  });

  it("streams the picked import file without buffering it whole", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    const { container } = render(<MemoryRouter><OfflineAi /></MemoryRouter>);
    const card = await screen.findByRole("listitem", { name: "SmolVLM2 500M (LiteRT, int4)" });
    fireEvent.click(within(card).getByRole("button", { name: /import smolvlm2 500m/i }));
    const file = new File(["not-the-model"], "model.fbmodel");
    const buffered = vi.spyOn(file, "arrayBuffer");
    Object.defineProperty(file, "stream", {
      configurable: true,
      value: () => {
        const bytes = new TextEncoder().encode("not-the-model");
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      },
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    expect(await within(card).findByText(/does not match the shipped catalogue pin/i)).toBeTruthy();
    expect(buffered).not.toHaveBeenCalled();
  });

  it("imports through the native package host when a document uri is available", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    const importPackageFromUri = vi.fn().mockResolvedValue({
      ok: true,
      manifest: {
        packageVersion: "1",
        entryId: "smolvlm2-500m-litert-int4",
        upstream: { repo: "r", rev: "v", file: "f" },
        createdAt: "2026-09-22T00:00:00.000Z",
        files: [],
      },
    });
    const { container } = render(
      <MemoryRouter>
        <OfflineAi
          nativePackageHost={{ importPackageFromUri, exportPackageToUri: vi.fn() }}
          importSourceUriForFile={() => "content://media/model.fbmodel"}
        />
      </MemoryRouter>,
    );
    const card = await screen.findByRole("listitem", { name: "SmolVLM2 500M (LiteRT, int4)" });
    fireEvent.click(within(card).getByRole("button", { name: /import smolvlm2 500m/i }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "model.fbmodel");
    const buffered = vi.spyOn(file, "arrayBuffer");
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(importPackageFromUri).toHaveBeenCalled());
    expect(importPackageFromUri).toHaveBeenCalledWith({
      entryId: "smolvlm2-500m-litert-int4",
      sourceUri: "content://media/model.fbmodel",
      expectedSha256: expect.any(String),
    });
    expect(await within(card).findByText(/installed by the platform installer/i)).toBeTruthy();
    expect(buffered).not.toHaveBeenCalled();
  });

  it("exports through the native package host when a destination uri is available", async () => {
    bridge.getCapabilities.mockResolvedValue(capabilities);
    bridge.getSettings.mockResolvedValue({ mode: "AUTO" });
    bridge.getModelStates.mockResolvedValue([{ id: "smolvlm2-500m", state: "NOT_INSTALLED" }]);
    bridge.onDownloadProgress.mockResolvedValue(() => Promise.resolve());
    bridge.onModelStateChange.mockResolvedValue(() => Promise.resolve());
    const exportPackageToUri = vi.fn().mockResolvedValue({
      ok: true,
      manifest: {
        packageVersion: "1",
        entryId: "smolvlm2-500m-litert-int4",
        upstream: { repo: "r", rev: "v", file: "f" },
        createdAt: "2026-09-22T00:00:00.000Z",
        files: [{ path: "weights/model.litertlm", bytes: 4, sha256: "ab", method: "STORE" }],
      },
      checksumsJson: "{}",
    });
    render(
      <MemoryRouter>
        <OfflineAi
          nativePackageHost={{ importPackageFromUri: vi.fn(), exportPackageToUri }}
          exportDestUriForEntry={() => "content://media/export.fbmodel"}
        />
      </MemoryRouter>,
    );
    const card = await screen.findByRole("listitem", { name: "SmolVLM2 500M (LiteRT, int4)" });
    fireEvent.click(within(card).getByRole("button", { name: /export smolvlm2 500m/i }));
    await waitFor(() => expect(exportPackageToUri).toHaveBeenCalledWith({
      entryId: "smolvlm2-500m-litert-int4",
      destUri: "content://media/export.fbmodel",
    }));
    expect(await within(card).findByText(/packaged 1 files for smolvlm2-500m-litert-int4/i)).toBeTruthy();
  });
});
