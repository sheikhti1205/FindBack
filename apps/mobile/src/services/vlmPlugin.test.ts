// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  getCapabilities: vi.fn(), getSettings: vi.fn(), setMode: vi.fn(), getModelStates: vi.fn(),
  downloadModel: vi.fn(), cancelDownload: vi.fn(), deleteModel: vi.fn(), embedTexts: vi.fn(), runGpuSelfTest: vi.fn(),
  analyzeImage: vi.fn(), cancelInference: vi.fn(), release: vi.fn(), addListener: vi.fn(),
}));
const state = vi.hoisted(() => ({ native: true }));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => state.native },
  registerPlugin: () => native,
}));

import { getVlmBridge, resetVlmBridgeCache } from "./vlmPlugin";

beforeEach(() => {
  state.native = true;
  Object.values(native).forEach((f) => f.mockReset());
  native.addListener.mockResolvedValue({ remove: vi.fn() });
});

describe("vlmPlugin native payload unwrapping", () => {
  it("unwraps getSettings {mode}", async () => {
    native.getSettings.mockResolvedValue({ mode: "QUALITY" });
    await expect(getVlmBridge().getSettings()).resolves.toEqual({ mode: "QUALITY" });
  });

  it("unwraps getModelStates {models}", async () => {
    native.getModelStates.mockResolvedValue({ models: [{ id: "smolvlm-256m", state: "READY_GPU" }] });
    await expect(getVlmBridge().getModelStates()).resolves.toHaveLength(1);
  });

  it("unwraps runGpuSelfTest {state} with imageUri", async () => {
    native.runGpuSelfTest.mockResolvedValue({ state: "GPU_UNAVAILABLE" });
    await expect(getVlmBridge().runGpuSelfTest("smolvlm-256m", "content://test-image")).resolves.toBe("GPU_UNAVAILABLE");
    expect(native.runGpuSelfTest).toHaveBeenCalledWith({ modelId: "smolvlm-256m", imageUri: "content://test-image" });
  });

  it("unwraps runGpuSelfTest {state} without imageUri", async () => {
    native.runGpuSelfTest.mockResolvedValue({ state: "GPU_UNSUPPORTED" });
    await expect(getVlmBridge().runGpuSelfTest("smolvlm-256m")).resolves.toBe("GPU_UNSUPPORTED");
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
});