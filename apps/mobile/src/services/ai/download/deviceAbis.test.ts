import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ available: true, supportedAbis: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.available },
  registerPlugin: (name: string) => {
    if (name !== "FindbackModelDownload") throw new Error(`Unexpected plugin ${name}`);
    return { supportedAbis: native.supportedAbis };
  },
}));
import { CapacitorModelDownloadDriver } from "./driver";

beforeEach(() => { native.available = true; native.supportedAbis.mockReset(); });

describe("model-neutral platform ABI bridge", () => {
  it("gets the device ABI list through the existing download plugin", async () => {
    native.supportedAbis.mockResolvedValue({ abis: ["arm64-v8a", "armeabi-v7a"] });
    expect(await new CapacitorModelDownloadDriver().supportedAbis()).toEqual(["arm64-v8a", "armeabi-v7a"]);
  });
  it("does not invent an ABI on web", async () => {
    native.available = false;
    await expect(new CapacitorModelDownloadDriver().supportedAbis()).rejects.toThrow(/absent on web/);
  });
  it("propagates native discovery failure for the service to fail closed", async () => {
    native.supportedAbis.mockRejectedValue(new Error("native unavailable"));
    await expect(new CapacitorModelDownloadDriver().supportedAbis()).rejects.toThrow("native unavailable");
  });
  it.each([undefined, null, 42, {}, { abis: "arm64-v8a" }, { abis: ["arm64-v8a", 42] }, { abis: ["arm64-v8a", null] }, { abis: ["arm64-v8a", ""] }, { abis: ["arm64-v8a", " arm64-v8a "] }, { abis: ["arm64-v8a", "arm64-v8a\n"] }, { abis: Object.assign(new Array<unknown>(2), { 0: "arm64-v8a" }) }])("rejects the entire malformed native payload: %j", async (raw) => {
    native.supportedAbis.mockResolvedValue(raw);
    expect(await new CapacitorModelDownloadDriver().supportedAbis()).toEqual([]);
  });
});
