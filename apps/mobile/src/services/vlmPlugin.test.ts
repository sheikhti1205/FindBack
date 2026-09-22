// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  getCapabilities: vi.fn(), getSettings: vi.fn(), setMode: vi.fn(), setCpuFallback: vi.fn(), getModelStates: vi.fn(),
  downloadModel: vi.fn(), cancelDownload: vi.fn(), deleteModel: vi.fn(), embedTexts: vi.fn(), runGpuSelfTest: vi.fn(),
  analyzeImage: vi.fn(), generateText: vi.fn(), runTextSelfTest: vi.fn(), getTextRuntimeStatus: vi.fn(),
  cancelInference: vi.fn(), release: vi.fn(), addListener: vi.fn(),
}));
const state = vi.hoisted(() => ({ native: true }));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => state.native },
  registerPlugin: () => native,
}));

import { getVlmBridge, resetVlmBridgeCache, isSettledState, isInstalledState, isTransferActive, getModelAction, nativePackageHostFrom, isTextBridge, textSeamsFromStatus } from "./vlmPlugin";
import { isTextRuntimePresent } from "./models/textRuntime";

beforeEach(() => {
  state.native = true;
  Object.values(native).forEach((f) => f.mockReset());
  native.addListener.mockResolvedValue({ remove: vi.fn() });
  resetVlmBridgeCache();
});

describe("vlmPlugin native payload unwrapping", () => {
  it("unwraps the real native getCapabilities payload", async () => {
    native.getCapabilities.mockResolvedValue({
      capabilities: {
        abi: "arm64-v8a",
        androidVersion: "14",
        apiLevel: 34,
        hardware: "pixel",
        deviceCategory: "physical",
        gpuVendor: "Qualcomm",
        gpuRenderer: "Adreno 730",
        memoryClassMb: 256,
        freeAppStorageMb: 1024,
        gpuDelegateClassPresent: true,
        runtimeVersion: "0.16.0",
      },
    });
    await expect(getVlmBridge().getCapabilities()).resolves.toMatchObject({ freeAppStorageMb: 1024 });
  });

  it("unwraps getSettings {mode} with CPU fallback defaulting on", async () => {
    native.getSettings.mockResolvedValue({ mode: "QUALITY" });
    await expect(getVlmBridge().getSettings()).resolves.toEqual({ mode: "QUALITY", allowCpuFallback: true });
  });

  it("passes through an explicit CPU fallback opt-out", async () => {
    native.getSettings.mockResolvedValue({ mode: "AUTO", allowCpuFallback: false });
    await expect(getVlmBridge().getSettings()).resolves.toEqual({ mode: "AUTO", allowCpuFallback: false });
  });

  it("sends setCpuFallback with the explicit choice", async () => {
    native.setCpuFallback.mockResolvedValue(undefined);
    await getVlmBridge().setCpuFallback(false);
    expect(native.setCpuFallback).toHaveBeenCalledWith({ allowed: false });
  });

  it("records no backend notice after a GPU run", async () => {
    native.analyzeImage.mockResolvedValue({ text: "{}", modelId: "smolvlm2-500m", backend: "gpu", runtime: "0.16.0", diagnostics: [] });
    const bridge = getVlmBridge();
    await bridge.analyzeImage({ mode: "AUTO", imageUri: "content://x", instruction: "i", maxOutputTokens: 224, temperature: 0.1 });
    expect(bridge.getLastBackendNotice()).toBeNull();
  });

  it("records an explicit notice after a CPU compatibility run", async () => {
    native.analyzeImage.mockResolvedValue({ text: "{}", modelId: "smolvlm2-500m", backend: "cpu", runtime: "0.16.0", diagnostics: ["CPU compatibility mode: GPU backend unavailable on this runtime."] });
    const bridge = getVlmBridge();
    await bridge.analyzeImage({ mode: "AUTO", imageUri: "content://x", instruction: "i", maxOutputTokens: 224, temperature: 0.1 });
    expect(bridge.getLastBackendNotice()).toMatch(/cpu compatibility mode/i);
  });

  it("unwraps getModelStates {models}", async () => {
    native.getModelStates.mockResolvedValue({ models: [{ id: "smolvlm-256m", state: "READY_GPU" }] });
    await expect(getVlmBridge().getModelStates()).resolves.toHaveLength(1);
  });

  it("passes through the full runGpuSelfTest result with imageUri", async () => {
    native.runGpuSelfTest.mockResolvedValue({ state: "GPU_UNAVAILABLE", error: "decode failed", failure: "INPUT_ERROR" });
    await expect(getVlmBridge().runGpuSelfTest("smolvlm-256m", "content://test-image")).resolves.toEqual({
      state: "GPU_UNAVAILABLE",
      error: "decode failed",
      failure: "INPUT_ERROR",
    });
    expect(native.runGpuSelfTest).toHaveBeenCalledWith({ modelId: "smolvlm-256m", imageUri: "content://test-image" });
  });

  it("passes through the full runGpuSelfTest result without imageUri", async () => {
    native.runGpuSelfTest.mockResolvedValue({ state: "GPU_UNSUPPORTED" });
    await expect(getVlmBridge().runGpuSelfTest("smolvlm-256m")).resolves.toEqual({ state: "GPU_UNSUPPORTED" });
    expect(native.runGpuSelfTest).toHaveBeenCalledWith({ modelId: "smolvlm-256m" });
  });

  it("unwraps embedTexts {vectors}", async () => {
    native.embedTexts.mockResolvedValue({ vectors: [[0.1, 0.2], [0.3, 0.4]] });
    await expect(getVlmBridge().embedTexts(["a", "b"])).resolves.toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(native.embedTexts).toHaveBeenCalledWith({ texts: ["a", "b"] });
  });

  it("sends analyzeImage with mode and never a modelId", async () => {
    native.analyzeImage.mockResolvedValue({ text: "{}", modelId: "smolvlm2-500m", backend: "gpu", runtime: "0.16.0", diagnostics: [] });
    await getVlmBridge().analyzeImage({ mode: "AUTO", imageUri: "content://x", instruction: "i", maxOutputTokens: 224, temperature: 0.1 });
    const arg = native.analyzeImage.mock.calls[0]![0];
    expect(arg.mode).toBe("AUTO");
    expect(arg).not.toHaveProperty("modelId");
  });

  it("registers and disposes the inference-state listener", async () => {
    const dispose = vi.fn();
    native.addListener.mockResolvedValue({ remove: dispose });
    const off = await getVlmBridge().onInferenceState(vi.fn());
    expect(native.addListener).toHaveBeenCalledWith("inferenceState", expect.any(Function));
    await off();
    expect(dispose).toHaveBeenCalled();
  });

  it("returns a web adapter that refuses local AI", async () => {
    state.native = false;
    resetVlmBridgeCache();
    await expect(
      getVlmBridge().analyzeImage({ mode: "AUTO", imageUri: "x", instruction: "y", maxOutputTokens: 224, temperature: 0.1 }),
    ).rejects.toThrow(/Android/i);
  });

  it("exposes no text methods on the web adapter (refusal by absence)", () => {
    state.native = false;
    resetVlmBridgeCache();
    const bridge = getVlmBridge();
    expect(isTextBridge(bridge)).toBe(false);
    expect(isTextRuntimePresent(bridge)).toBe(false);
  });
  it("classifies settled vs installed states for transfer sequencing", () => {
    expect(isSettledState("DOWNLOADING")).toBe(false);
    expect(isSettledState("QUEUED")).toBe(false);
    expect(isSettledState("VERIFYING_FILE")).toBe(false);
    expect(isSettledState("GPU_SELF_TESTING")).toBe(false);
    expect(isSettledState("INSTALLED_UNVERIFIED")).toBe(true);
    expect(isSettledState("DOWNLOAD_FAILED")).toBe(true);
    expect(isInstalledState("READY_GPU")).toBe(true);
    expect(isInstalledState("INSTALLED_UNVERIFIED")).toBe(true);
    expect(isInstalledState("GPU_UNAVAILABLE")).toBe(true);
    expect(isInstalledState("PAUSED")).toBe(false);
  });

  it("waitForSettled resolves only after the model leaves in-progress states", async () => {
    native.getModelStates
      .mockResolvedValueOnce({ models: [{ id: "smolvlm2-500m", state: "DOWNLOADING" }] })
      .mockResolvedValue({ models: [{ id: "smolvlm2-500m", state: "INSTALLED_UNVERIFIED" }] });
    const info = await getVlmBridge().waitForSettled("smolvlm2-500m", { intervalMs: 1, timeoutMs: 2000 });
    expect(info.state).toBe("INSTALLED_UNVERIFIED");
    expect(native.getModelStates).toHaveBeenCalledTimes(2);
  });

  it("waitForSettled rejects on timeout rather than resolving falsely", async () => {
    native.getModelStates.mockResolvedValue({ models: [{ id: "smolvlm2-500m", state: "DOWNLOADING" }] });
    await expect(
      getVlmBridge().waitForSettled("smolvlm2-500m", { intervalMs: 1, timeoutMs: 5 }),
    ).rejects.toThrow(/Timed out/i);
  });

  it("marks every transfer step active and GPU_SELF_TESTING as non-download (W5 #20)", () => {
    for (const s of ["QUEUED", "WAITING_FOR_NETWORK", "WAITING_FOR_WIFI", "DOWNLOADING", "PAUSING", "VERIFYING_CHUNK", "VERIFYING_HASH", "VERIFYING_FILE", "REPAIRING"] as const) {
      expect(isTransferActive(s)).toBe(true);
      expect(getModelAction(s).canDownload).toBe(false);
      expect(getModelAction(s).isTransferActive).toBe(true);
    }
    expect(isTransferActive("GPU_SELF_TESTING")).toBe(false);
    expect(getModelAction("GPU_SELF_TESTING").canDownload).toBe(false);
    expect(getModelAction("NOT_INSTALLED").canDownload).toBe(true);
    expect(getModelAction("READY_GPU").canSelfTest).toBe(true);
  });
});

describe("nativePackageHostFrom", () => {
  const manifest = {
    packageVersion: "1" as const,
    entryId: "entry-a",
    upstream: { repo: "r", rev: "v", file: "f" },
    createdAt: "2026-09-22T00:00:00Z",
    files: [{ path: "weights/model.litertlm", bytes: 3, sha256: "abc", method: "STORE" as const }],
  };

  it("passes the installer-observed import manifest through", async () => {
    const host = nativePackageHostFrom({
      importPackageFromUri: async () => ({ ok: true, manifest }),
      exportPackageToUri: async () => { throw new Error("unused"); },
    });
    const result = await host.importPackageFromUri({ entryId: "entry-a", sourceUri: "content://x", expectedSha256: "pin" });
    expect(result).toEqual({ ok: true, manifest });
  });

  it("maps a coded native import rejection to the shared failure code", async () => {
    const rejection = Object.assign(new Error("Checksum mismatch for weights/model.litertlm."), { code: "HASH_MISMATCH" });
    const host = nativePackageHostFrom({
      importPackageFromUri: async () => { throw rejection; },
      exportPackageToUri: async () => { throw new Error("unused"); },
    });
    const result = await host.importPackageFromUri({ entryId: "entry-a", sourceUri: "content://x", expectedSha256: "pin" });
    expect(result).toEqual({ ok: false, code: "HASH_MISMATCH", reason: "Checksum mismatch for weights/model.litertlm." });
  });

  it("fails a malformed native import result closed without installing", async () => {
    const host = nativePackageHostFrom({
      importPackageFromUri: async () => ({ ok: true }),
      exportPackageToUri: async () => { throw new Error("unused"); },
    });
    const result = await host.importPackageFromUri({ entryId: "entry-a", sourceUri: "content://x", expectedSha256: "pin" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CORRUPT_ARCHIVE");
  });

  it("passes the installer-observed export manifest and checksums through", async () => {
    const host = nativePackageHostFrom({
      importPackageFromUri: async () => { throw new Error("unused"); },
      exportPackageToUri: async () => ({ ok: true, manifest, checksumsJson: "{}" }),
    });
    const result = await host.exportPackageToUri({ entryId: "entry-a", destUri: "content://y" });
    expect(result).toEqual({ ok: true, manifest, checksumsJson: "{}" });
  });

  it("fails an unknown native export error closed as corrupt archive", async () => {
    const host = nativePackageHostFrom({
      importPackageFromUri: async () => { throw new Error("unused"); },
      exportPackageToUri: async () => { throw new Error("boom"); },
    });
    const result = await host.exportPackageToUri({ entryId: "entry-a", destUri: "content://y" });
    expect(result).toEqual({ ok: false, code: "CORRUPT_ARCHIVE", reason: "boom" });
  });
});

describe("vlmPlugin text bridge (explicit-modelId production path)", () => {
  it("sends generateText with the required modelId and never substitutes", async () => {
    native.generateText.mockResolvedValue({ text: "answer", modelId: "qwen3-0.6b", backend: "gpu", runtime: "0.16.0" });
    const bridge = getVlmBridge();
    await expect(
      bridge.generateText?.({ modelId: "qwen3-0.6b", prompt: "hi", maxOutputTokens: 64, temperature: 0.1 }),
    ).resolves.toEqual({ text: "answer", modelId: "qwen3-0.6b" });
    expect(native.generateText).toHaveBeenCalledWith({
      modelId: "qwen3-0.6b",
      prompt: "hi",
      maxOutputTokens: 64,
      temperature: 0.1,
    });
  });

  it("narrows the native bridge to the typed text surface without casting", () => {
    const bridge = getVlmBridge();
    expect(isTextBridge(bridge)).toBe(true);
    expect(isTextRuntimePresent(bridge)).toBe(true);
    if (isTextBridge(bridge)) {
      expect(typeof bridge.generateText).toBe("function");
      expect(typeof bridge.runTextSelfTest).toBe("function");
      expect(typeof bridge.getTextRuntimeStatus).toBe("function");
    } else {
      throw new Error("native bridge must expose the text surface");
    }
  });

  it("passes runTextSelfTest through with the explicit modelId", async () => {
    native.runTextSelfTest.mockResolvedValue({
      modelId: "qwen3-0.6b",
      ready: true,
      state: "TEXT_READY",
      diagnostics: ["init ok"],
    });
    const bridge = getVlmBridge();
    await expect(bridge.runTextSelfTest?.("qwen3-0.6b")).resolves.toMatchObject({
      ready: true,
      state: "TEXT_READY",
    });
    expect(native.runTextSelfTest).toHaveBeenCalledWith({ modelId: "qwen3-0.6b" });
  });

  it("passes getTextRuntimeStatus through without initializing", async () => {
    native.getTextRuntimeStatus.mockResolvedValue({
      modelId: "qwen3-0.6b",
      ready: false,
      nativeRunning: false,
      backend: "gpu",
      modelFilePresent: true,
    });
    const bridge = getVlmBridge();
    await expect(bridge.getTextRuntimeStatus?.()).resolves.toEqual({
      modelId: "qwen3-0.6b",
      ready: false,
      nativeRunning: false,
      backend: "gpu",
      modelFilePresent: true,
    });
    expect(native.getTextRuntimeStatus).toHaveBeenCalledWith();
  });

  it("maps native text status to seams, fail closed on missing status", () => {
    expect(textSeamsFromStatus(null)).toEqual({ textInstalled: false, textReady: false });
    expect(textSeamsFromStatus(undefined)).toEqual({ textInstalled: false, textReady: false });
    expect(
      textSeamsFromStatus({
        modelId: "qwen3-0.6b", ready: true, nativeRunning: false, backend: "gpu",
        modelFilePresent: true, installed: true, textReady: true,
      }),
    ).toEqual({ textInstalled: true, textReady: true });
    expect(
      textSeamsFromStatus({
        modelId: "qwen3-0.6b", ready: false, nativeRunning: false, backend: "gpu",
        modelFilePresent: true, installed: true, textReady: false,
      }),
    ).toEqual({ textInstalled: true, textReady: false });
    expect(
      textSeamsFromStatus({
        modelId: "qwen3-0.6b", ready: false, nativeRunning: false, backend: "gpu",
        modelFilePresent: true, installed: false, textReady: false,
      }),
    ).toEqual({ textInstalled: false, textReady: false });
  });
});
