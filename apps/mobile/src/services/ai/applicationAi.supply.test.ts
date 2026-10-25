import { expect, it } from "vitest";
import { ApplicationAiService } from "./applicationAi";
import type { ModelDownloadDriver } from "./download/driver";
import type { LlamaNativeBridge } from "./llama/adapter";
it("acquires Granite, evaluates explicitly using canonical owner and releases residency", async () => {
  const disk = new Map<string, string>(); const calls: string[] = [];
  const driver: ModelDownloadDriver = {
    supportedAbis: async () => ["arm64-v8a"],
    rootDir: async () => "/private", freeBytes: async () => 1e10, stagedSize: async () => 0, readJournalText: async () => null,
    hashFile: async (p) => disk.get(p) ?? "", cancelDownload: async () => {}, removeFile: async (p) => { disk.delete(p); },
    promoteFile: async (a, b) => { disk.set(b, disk.get(a)!); },
    download: async (a) => { disk.set(a.stagingPath, a.expectedSha256); return { receivedBytes: a.maxBytes, totalBytes: a.maxBytes, actualHex: a.expectedSha256, finalUrl: a.url }; },
  };
  const llama: LlamaNativeBridge = {
    bridgeName: "llama-cpp-lab", isLlamaAvailable: async () => true,
    loadLlamaModel: async () => { calls.push("load"); }, unloadLlamaModel: async () => { calls.push("unload"); }, cancelGeneration: async () => {},
    inferLlama: async function* () { calls.push("infer"); yield { textDelta: "hello" }; },
  };
  const smol = { bridgeName: "smolvlm2-litertlm", isVisionAvailable: async () => false, loadVisionModel: async () => {}, unloadVisionModel: async () => {}, cancelGeneration: async () => {}, describeImage: async function* () {}, collectDeviceFacts: async () => ({ supportedAbis: ["arm64-v8a"] }) };
  const service = new ApplicationAiService({ android: true, driver, llama, smol });
  await service.ready;
  await service.download("granite-3.3-2b-instruct-q4_0");
  expect(await service.evaluate("granite-3.3-2b-instruct-q4_0", { optIn: true, prompt: "Say hello" })).toBe("hello");
  expect(calls).toContain("load"); expect(calls).toContain("infer"); expect(calls.at(-1)).toBe("unload");
  expect(service.residency.owner).toBe("none");
  await expect(service.evaluate("granite-3.3-2b-instruct-q4_0", { optIn: false, prompt: "Say hello" })).rejects.toThrow();
  expect(service.registry.requireDescriptor("granite-3.3-2b-instruct-q4_0").taskRoles).toEqual([]);
});
