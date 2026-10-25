import { describe, expect, it } from "vitest";
import { ApplicationAiService, DOWNLOAD_MODELS } from "./applicationAi";
import { productionModelRegistry, QWEN_TEXT_DESCRIPTOR, SMOL_VISION_DESCRIPTOR, type ModelDescriptor } from "./modelDescriptors";
import { NEEDLE_MODEL_ID } from "./needle/embedder";
import type { ModelDownloadDriver } from "./download/driver";

function platform() {
  const disk = new Map<string, string>();
  const calls: string[] = [];
  const driver: ModelDownloadDriver = {
    supportedAbis: async () => ["arm64-v8a"], rootDir: async () => "/private/ai-models",
    freeBytes: async () => 2_000_000_000,
    stagedSize: async (path) => disk.has(path) ? 1 : 0,
    readJournalText: async () => null,
    download: async (attempt) => {
      calls.push(`download:${attempt.modelId}`);
      disk.set(attempt.stagingPath, attempt.expectedSha256);
      return { receivedBytes: attempt.maxBytes, totalBytes: attempt.maxBytes, actualHex: attempt.expectedSha256, finalUrl: attempt.url };
    },
    cancelDownload: async () => {},
    hashFile: async (path) => { if (!disk.has(path)) throw new Error("missing"); return disk.get(path)!; },
    promoteFile: async (from, to) => { disk.set(to, disk.get(from)!); disk.delete(from); },
    removeFile: async (path) => { disk.delete(path); },
  };
  let loaded = false;
  const needle = {
    bridgeName: "needle-cact" as const, isNeedleAvailable: async () => loaded,
    embeddingDimension: async () => 2,
    loadModel: async () => { calls.push("needle-load"); loaded = true; return 2; },
    embedNeedleTexts: async (texts: string[]) => texts.map(() => [1, 0]),
    initTools: async () => {},
    completeJson: async () => JSON.stringify({ function_calls: [{ name: "search_filters", arguments: { query: "umbrella" } }] }),
    unload: async () => { loaded = false; },
  };
  const smol = {
    bridgeName: "smolvlm2-litertlm" as const,
    isVisionAvailable: async () => { calls.push("vision-probe"); return true; },
    loadVisionModel: async () => { calls.push("vision-load"); },
    unloadVisionModel: async () => { calls.push("vision-unload"); },
    describeImage: async function* () { calls.push("vision-generate"); yield { textDelta: "obsolete" }; },
    cancelGeneration: async () => {},
  };
  const qwenText = {
    bridgeName: "qwen3-litertlm-text" as const,
    isTextAvailable: async () => { calls.push("qwen-probe"); return true; },
    loadTextModel: async () => { calls.push("qwen-load"); },
    unloadTextModel: async () => { calls.push("qwen-unload"); },
    generateText: async function* () { calls.push("qwen-generate"); yield { textDelta: "obsolete" }; },
    cancelGeneration: async () => {},
  };
  function seed(d: ModelDescriptor) {
    const path = `/private/ai-models/models/${d.modelId}/${d.revision}/${d.fileName}`;
    disk.set(path, d.sha256);
    return path;
  }
  const llama = {
    bridgeName: "llama-cpp-lab" as const, isLlamaAvailable: async () => false,
    loadLlamaModel: async () => { calls.push("llama-load"); },
    unloadLlamaModel: async () => { calls.push("llama-unload"); },
    inferLlama: async function* () { calls.push("llama-generate"); yield { textDelta: "obsolete" }; },
    cancelGeneration: async () => {},
  };
  return { disk, calls, driver, needle, smol, qwenText, llama, seed };
}

describe("retired generative records in the real production configuration", () => {
  it("offers only the retained helper, keeping old pins solely for cleanup", () => {
    const registry = productionModelRegistry();
    expect(registry.catalogue().map(d => d.modelId)).toEqual(["needle3-cact-l20"]);
    expect(DOWNLOAD_MODELS.map(d => d.modelId)).toEqual(["needle3-cact-l20"]);
    expect(registry.advancedCatalogue()).toEqual([]);
    expect(registry.visionDescriptor()).toBeUndefined();
    for (const old of [QWEN_TEXT_DESCRIPTOR, SMOL_VISION_DESCRIPTOR]) {
      expect(registry.requireDescriptor(old.modelId)).toMatchObject({
        cleanupOnly: true, downloadable: false, importable: false, taskRoles: [], capabilities: old.capabilities,
        revision: old.revision, sha256: old.sha256, bytes: old.bytes, fileName: old.fileName,
      });
    }
  });

  it("refuses direct generative downloads and evaluation without touching acquisition or native load", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    for (const id of ["qwen3-0.6b-dynamic-int4", "smolvlm2-500M-vision", "granite-3.3-2b-instruct-q4_0"]) {
      await expect(service.download(id)).rejects.toThrow(/no longer available/i);
      await expect(service.evaluate(id, { optIn: true, prompt: "hello" })).rejects.toThrow(/no longer available/i);
    }
    expect(p.calls).toEqual([]);
  });

  it("reconciles and removes old installs but never lets their presence select a generative producer", async () => {
    const p = platform();
    const qwenPath = p.seed(QWEN_TEXT_DESCRIPTOR);
    const visionPath = p.seed(SMOL_VISION_DESCRIPTOR);
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    expect(service.manager.statusOf("qwen3-0.6b-dynamic-int4")).toMatchObject({ download: "installed", checksumVerified: true });
    expect(service.manager.statusOf("smolvlm2-500M-vision")).toMatchObject({ download: "installed", checksumVerified: true });
    expect((await service.offlineAdapter().listModels!()).map(row => row.id)).toEqual([]);
    await service.download(NEEDLE_MODEL_ID);
    const result = await service.route("extract-search-filters", { prompt: "umbrella" }, { traceId: "retained-search" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance).toMatchObject({ modelId: "needle3-cact-l20", runtimeId: "needle-cact" });
      expect(result.value).toMatchObject({ fields: { query: "umbrella" } });
    }
    expect(await service.embedNeedle(["umbrella"])).toEqual([[1, 0]]);
    expect(p.calls).not.toEqual(expect.arrayContaining(["qwen-load"]));
    expect(p.calls).not.toContain("qwen-probe");
    expect(p.calls).not.toContain("qwen-generate");
    expect(p.calls).not.toContain("vision-probe");
    expect(p.calls).not.toContain("vision-load");
    expect(p.calls).not.toContain("vision-generate");
    await service.remove(QWEN_TEXT_DESCRIPTOR.modelId);
    await service.remove(SMOL_VISION_DESCRIPTOR.modelId);
    expect(p.disk.has(qwenPath)).toBe(false);
    expect(p.disk.has(visionPath)).toBe(false);
    expect(service.manager.statusOf(NEEDLE_MODEL_ID)?.checksumVerified).toBe(true);
  });

  it("refuses new generative imports before opening the native picker or downloading bytes", async () => {
    const p = platform();
    const driver: ModelDownloadDriver = { ...p.driver,
      writeMetadata: async () => {},
      pickAndStage: async () => { p.calls.push("picker"); return { actualHex: "b".repeat(64), bytes: 128 }; },
    };
    const service = new ApplicationAiService({ android: true, ...p, driver });
    await service.ready;
    for (const options of [
      { format: "gguf" as const },
      { format: "litertlm" as const, modality: "text" as const },
      { format: "litertlm" as const, modality: "vision" as const },
      { modelId: QWEN_TEXT_DESCRIPTOR.modelId },
      { modelId: SMOL_VISION_DESCRIPTOR.modelId },
    ]) await expect(service.importLocal({ ...options, license: "Apache-2.0" })).rejects.toThrow(/no longer available/i);
    for (const spec of [
      { format: "gguf" as const },
      { format: "litertlm" as const, modality: "text" as const },
      { format: "litertlm" as const, modality: "vision" as const },
    ]) await expect(service.importUrl({ ...spec, sha256: "b".repeat(64), bytes: 128, license: "Apache-2.0", url: "https://example.test/model" })).rejects.toThrow(/no longer available/i);
    expect(p.calls).toEqual([]);
  });

  it("has no production vision measurement or image task even with old installed files", async () => {
    const p = platform(); p.seed(SMOL_VISION_DESCRIPTOR);
    const service = new ApplicationAiService({ android: true, ...p }); await service.ready;
    await expect(service.measure("cpu")).rejects.toThrow(/no vision model/i);
    const result = await service.route("analyze-image", { prompt: "describe", imageBase64: "synthetic" }, { traceId: "retired-image" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denialReason).toBe("NO_RUNTIME");
    expect(p.calls).toEqual([]);
  });

  it("refuses a saved retired Chat selection without cloud fallback or reading image bytes", async () => {
    const p = platform(); p.seed(QWEN_TEXT_DESCRIPTOR); p.seed(SMOL_VISION_DESCRIPTOR);
    const service = new ApplicationAiService({ android: true, ...p }); await service.ready;
    const adapter = service.offlineAdapter(async () => { throw new Error("Must not read images"); });
    const events = [];
    for await (const event of adapter.complete({
      selection: { accountId: "u", provider: "offline", modelId: "qwen3-0.6b-dynamic-int4", mode: "free-only" },
      task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
      currentText: "help", approvedImageIds: ["old-image"], authorizedResultIds: [],
      maxOutputTokens: 64, signal: new AbortController().signal,
    })) events.push(event);
    expect(events).toEqual([
      { kind: "error", attempt: 1, code: "model_retired", retryable: false, message: "On-device Chat is no longer available. Choose a cloud provider in Settings." },
      { kind: "done", attempt: 1, stopReason: "error" },
    ]);
    const prose = await service.route("answer-help", { prompt: "help" }, { traceId: "no-prose" });
    expect(prose.ok).toBe(false);
    if (!prose.ok) expect(prose.denialReason).toBe("NO_RUNTIME");
    expect(p.calls).toEqual([]);
  });

  it("attributes failed retained readiness to Needle rather than a retired Qwen producer", async () => {
    const p = platform();
    p.needle.loadModel = async () => { throw new Error("load failed"); };
    const service = new ApplicationAiService({ android: true, ...p }); await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    const result = await service.route("extract-search-filters", { prompt: "umbrella" }, { traceId: "needle-unready" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("needle3-cact-l20");
      expect(result.error).not.toMatch(/qwen/i);
    }
  });

  it("keeps imported vision identity and modality through cleanup of a different old import", async () => {
    const p = platform();
    const visionHash = "b".repeat(64), textHash = "c".repeat(64);
    let metadata = JSON.stringify([
      { sha256: visionHash, bytes: 128, format: "litertlm", modality: "vision", license: "Apache-2.0" },
      { sha256: textHash, bytes: 128, format: "gguf", modality: "text", license: "Apache-2.0" },
    ]);
    const visionPath = `/private/ai-models/models/imported-${visionHash}/${visionHash}/model.litertlm`;
    p.disk.set(visionPath, visionHash);
    p.disk.set(`/private/ai-models/models/imported-${textHash}/${textHash}/model.gguf`, textHash);
    const driver: ModelDownloadDriver = { ...p.driver, readMetadata: async () => metadata, writeMetadata: async (_path, value) => { metadata = value; } };
    const service = new ApplicationAiService({ android: true, ...p, driver }); await service.ready;
    expect(service.registry.requireDescriptor(`imported-${visionHash}`)).toMatchObject({ cleanupOnly: true, capabilities: ["vision"], taskRoles: [] });
    await expect(service.evaluate(`imported-${visionHash}`, { optIn: true, prompt: "describe", imageBase64: "synthetic" })).rejects.toThrow(/no longer available/i);
    await service.remove(`imported-${textHash}`);
    expect(JSON.parse(metadata)).toEqual([{ sha256: visionHash, bytes: 128, format: "litertlm", modality: "vision", license: "Apache-2.0" }]);
    const restarted = new ApplicationAiService({ android: true, ...p, driver }); await restarted.ready;
    expect(restarted.registry.requireDescriptor(`imported-${visionHash}`)).toMatchObject({ cleanupOnly: true, runtimeId: "smolvlm2-litertlm" });
    expect(restarted.manager.statusOf(`imported-${visionHash}`)?.checksumVerified).toBe(true);
    await restarted.remove(`imported-${visionHash}`);
    expect(p.disk.has(visionPath)).toBe(false);
  });
});
