// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  getCapabilities: vi.fn(),
  getSettings: vi.fn(),
  setMode: vi.fn(),
  setCpuFallback: vi.fn(),
  getModelStates: vi.fn(),
  downloadModel: vi.fn(),
  cancelDownload: vi.fn(),
  deleteModel: vi.fn(),
  embedTexts: vi.fn(),
  runGpuSelfTest: vi.fn(),
  analyzeImage: vi.fn(),
  generateText: vi.fn(),
  runTextSelfTest: vi.fn(),
  getTextRuntimeStatus: vi.fn(),
  cancelInference: vi.fn(),
  release: vi.fn(),
  addListener: vi.fn(),
  importPackageFromUri: vi.fn(),
  exportPackageToUri: vi.fn(),
}));
const state = vi.hoisted(() => ({ native: true }));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => state.native },
  registerPlugin: () => native,
}));

import {
  getNativePackageHost,
  getVlmBridge,
  resetVlmBridgeCache,
} from "./vlmPlugin";

beforeEach(() => {
  state.native = true;
  Object.values(native).forEach((f) => f.mockReset());
  native.addListener.mockResolvedValue({ remove: vi.fn() });
  resetVlmBridgeCache();
});

describe("vlmPlugin workset 3 (native RAM + package host)", () => {
  it("passes the passive availableRamMb capability through", async () => {
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
        availableRamMb: 2048,
        gpuDelegateClassPresent: true,
        runtimeVersion: "0.16.0",
      },
    });
    await expect(getVlmBridge().getCapabilities()).resolves.toMatchObject({
      availableRamMb: 2048,
    });
  });

  it("tolerates older native builds without availableRamMb", async () => {
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
    const caps = await getVlmBridge().getCapabilities();
    expect(caps.availableRamMb ?? null).toBeNull();
  });

  it("wires the production package host on Android and null on web", async () => {
    const host = getNativePackageHost();
    expect(host).not.toBeNull();
    state.native = false;
    resetVlmBridgeCache();
    expect(getNativePackageHost()).toBeNull();
  });
});
