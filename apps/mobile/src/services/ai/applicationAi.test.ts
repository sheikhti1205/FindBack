import { describe, expect, it } from "vitest";
import { ApplicationAiService, DEVICE_CORPUS_VERSION } from "./applicationAi";
import { NEEDLE_DESCRIPTOR, SMOL_VISION_DESCRIPTOR, type ModelDescriptor } from "./modelDescriptors";
import { NEEDLE_MODEL_ID } from "./needle/embedder";
import { PROBE_VERSION } from "./deviceProbe";
import type { ModelDownloadDriver } from "./download/driver";
import type { OfflineVisionNativeBridge } from "./providers/offline";

function platform() {
  const disk = new Map<string, string>();
  const calls: string[] = [];
  const driver: ModelDownloadDriver = {
    rootDir: async () => "/private/ai-models",
    freeBytes: async () => 2_000_000_000,
    stagedSize: async (path) => disk.has(path) ? 1 : 0,
    readJournalText: async () => null,
    download: async (attempt) => {
      calls.push("download");
      attempt.onProgress?.(20, null);
      disk.set(attempt.stagingPath, attempt.expectedSha256);
      return { receivedBytes: attempt.maxBytes, totalBytes: attempt.maxBytes, actualHex: attempt.expectedSha256, finalUrl: attempt.url };
    },
    cancelDownload: async () => {},
    hashFile: async (path) => { if (!disk.has(path)) throw new Error("missing"); return disk.get(path)!; },
    promoteFile: async (from, to) => { disk.set(to, disk.get(from)!); disk.delete(from); },
    removeFile: async (path) => { disk.delete(path); },
  };
  let resident = false;
  const needle = {
    bridgeName: "needle-cact" as const,
    isNeedleAvailable: async () => resident,
    embeddingDimension: async () => 2,
    loadModel: async () => { calls.push("needle-load"); resident = true; return 2; },
    embedNeedleTexts: async (texts: string[]) => texts.map(() => [1, 0]),
    initTools: async () => {},
    completeJson: async () => JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "red umbrella" } }] }),
    unload: async () => { calls.push("needle-unload"); resident = false; },
  };
  const smol: OfflineVisionNativeBridge = {
    bridgeName: "smolvlm2-litertlm",
    isVisionAvailable: async () => calls.includes("vision-load"),
    loadVisionModel: async () => { calls.push("vision-load"); },
    unloadVisionModel: async () => {},
    describeImage: async function* () { calls.push("vision-describe"); yield { textDelta: "A red umbrella." }; },
    cancelGeneration: async () => {},
  };
  return { disk, calls, driver, needle, smol };
}

describe("application-owned AI", () => {
  it("blocks inference and measurement while a removal owns runtime residency", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(NEEDLE_DESCRIPTOR.modelId);
    await service.download(SMOL_VISION_DESCRIPTOR.modelId);
    let release!: () => void;
    let entered!: () => void;
    const unloading = new Promise<void>((resolve) => { entered = resolve; });
    p.needle.unload = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); };
    const removal = service.remove(NEEDLE_DESCRIPTOR.modelId);
    await unloading;
    try {
      await expect(service.embedNeedle(["umbrella"])).rejects.toThrow(/busy/);
      await expect(service.measure("cpu")).rejects.toThrow(/busy/);
    } finally { release(); await removal; }
  });

  it("revokes a failed measured GPU choice and retries CPU with an explicit notice", async () => {
    const p = platform();
    const backends: string[] = [];
    p.smol.loadVisionModel = async ({ backend }) => {
      backends.push(backend);
      if (backend === "gpu") throw new Error("GPU initialize failed");
      p.calls.push("vision-load");
    };
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    const modelId = SMOL_VISION_DESCRIPTOR.modelId;
    await service.download(modelId);
    service.probeRecords = ["cpu", "gpu"].map((backend) => ({
      socModel: "test", gpuInfo: "test", ramMb: 8192, osVersion: "test", backend: backend as "cpu" | "gpu",
      ttftMs: backend === "gpu" ? 100 : 200, tokensPerSec: backend === "gpu" ? 20 : 10,
      corpusVersion: DEVICE_CORPUS_VERSION, probeVersion: PROBE_VERSION,
      modelRev: service.probeContext.modelRev, correctnessPass: true,
    }));
    const events = [];
    for await (const event of service.offlineAdapter(async () => "approved-bytes").complete({
      selection: { accountId: "u", provider: "offline", modelId, mode: "free-only" },
      task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
      currentText: "Describe", approvedImageIds: ["img-1"], authorizedResultIds: [], maxOutputTokens: 64,
      signal: new AbortController().signal,
    })) events.push(event);
    expect(backends).toEqual(["gpu", "cpu"]);
    expect(events.some((event) => event.kind === "text")).toBe(true);
    expect(service.notice(modelId)).toMatch(/GPU.*failed.*CPU/i);
    expect(service.probeRecords.some((record) => record.backend === "gpu")).toBe(false);
  });

  it("downloads into the shared manager, lazily loads Needle and routes real embeddings; removal revokes readiness", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    const id = NEEDLE_MODEL_ID;
    await expect(service.embedNeedle(["umbrella"])).rejects.toThrow(/installed/);
    await service.download(id);
    expect(service.manager.statusOf(id)?.checksumVerified).toBe(true);
    expect(await service.embedNeedle(["umbrella", "keys"])).toEqual([[1, 0], [1, 0]]);
    expect(p.calls).toContain("needle-load");
    await service.remove(id);
    expect(service.manager.statusOf(id)?.download).toBe("not-installed");
    expect(p.calls).toContain("needle-unload");
    await expect(service.embedNeedle(["umbrella"])).rejects.toThrow(/installed/);
  });

  it("recovers installs only after rehashing the current pinned file, never from persisted claims", async () => {
    const p = platform();
    const first = new ApplicationAiService({ android: true, ...p });
    await first.ready;
    const id = NEEDLE_MODEL_ID;
    await first.download(id);
    const second = new ApplicationAiService({ android: true, ...p });
    await second.ready;
    expect(second.manager.statusOf(id)?.checksumVerified).toBe(true);
    for (const path of p.disk.keys()) p.disk.set(path, "bad");
    const third = new ApplicationAiService({ android: true, ...p });
    await third.ready;
    expect(third.manager.statusOf(id)?.checksumVerified).toBe(false);
    expect(await third.offlineAdapter().listModels?.()).toEqual([]);
  });

  it("exposes installed Android offline models and binds cold Smol image requests without cloud", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    const modelId = SMOL_VISION_DESCRIPTOR.modelId;
    await service.download(modelId);
    const adapter = service.offlineAdapter(async () => "approved-bytes");
    expect((await adapter.listModels?.())?.[0]?.input).toContain("image");
    const events = [];
    for await (const event of adapter.complete({
      selection: { accountId: "u", provider: "offline", modelId, mode: "free-only" },
      task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
      currentText: "Describe", approvedImageIds: ["img-1"], authorizedResultIds: [], maxOutputTokens: 64,
      signal: new AbortController().signal,
    })) events.push(event);
    expect(events).toContainEqual({ kind: "text", attempt: 1, delta: "A red umbrella." });
    expect(p.calls).toContain("vision-load");
    expect(p.calls).toContain("vision-describe");
  });

  it("surfaces a real vision load failure as runtime_load_failed while the model is installed", async () => {
    const p = platform();
    p.smol.loadVisionModel = async () => { throw new Error("GPU initialize failed hard"); };
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    const modelId = SMOL_VISION_DESCRIPTOR.modelId;
    await service.download(modelId);
    const adapter = service.offlineAdapter(async () => "approved-bytes");
    const events: { kind: string; code?: string; message?: string }[] = [];
    for await (const event of adapter.complete({
      selection: { accountId: "u", provider: "offline", modelId, mode: "free-only" },
      task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
      currentText: "Describe", approvedImageIds: ["img-1"], authorizedResultIds: [], maxOutputTokens: 64,
      signal: new AbortController().signal,
    })) events.push(event as { kind: string; code?: string; message?: string });
    const failure = events.find((event) => event.kind === "error");
    expect(failure?.code).toBe("runtime_load_failed");
    expect(failure?.message).toContain("GPU initialize failed hard");
  });

  it("fails closed on web without constructing or contacting native seams", async () => {
    const service = new ApplicationAiService({ android: false });
    await service.ready;
    expect(() => service.offlineAdapter()).toThrow(/Android/);
    await expect(service.download(NEEDLE_MODEL_ID)).rejects.toThrow(/Android/);
  });

  it("tracks single-resident ownership across loads and account reset", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    expect(service.residency.owner).toBe("none");
    await service.embedNeedle(["umbrella"]);
    expect(service.residency.owner).toBe("needle");
    await service.resetForAccount();
    expect(service.residency).toMatchObject({ owner: "none", claimed: false, inflight: 0 });
    // Models survive account reset: logout never wipes verified files.
    expect(service.manager.statusOf(NEEDLE_MODEL_ID)?.checksumVerified).toBe(true);
  });

  it("resolves ownership by descriptor, never by catalogue position", async () => {
    const p = platform();
    // Deliberately reordered: vision first. Behavior must not change.
    const service = new ApplicationAiService({
      android: true,
      ...p,
      descriptors: [SMOL_VISION_DESCRIPTOR, NEEDLE_DESCRIPTOR],
    });
    await service.ready;
    expect(service.registry.visionDescriptor()?.modelId).toBe(SMOL_VISION_DESCRIPTOR.modelId);
    await service.download(NEEDLE_MODEL_ID);
    await service.remove(NEEDLE_MODEL_ID);
    expect(p.calls).toContain("needle-unload");
    expect(p.calls).not.toContain("vision-load");
    expect(service.probeContext.modelRev).toBe(SMOL_VISION_DESCRIPTOR.revision);
  });

  it("a third descriptor without a production adapter fails closed without touching Needle or Smol", async () => {
    const p = platform();
    const third: ModelDescriptor = {
      modelId: "test-third-model",
      displayName: "Test third",
      runtimeId: "test-unowned-runtime",
      format: "gguf",
      revision: "rev3",
      sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      fileName: "third.gguf",
      url: "https://example.invalid/third.gguf",
      bytes: 1024,
      capabilities: ["text"],
      taskRoles: [],
      maturity: "experimental",
      trust: "curated",
      license: "test-only",
      minRamMb: 512,
      recommendedRamMb: 512,
      abis: ["arm64-v8a"],
      downloadable: false,
    };
    const service = new ApplicationAiService({
      android: true,
      ...p,
      descriptors: [NEEDLE_DESCRIPTOR, SMOL_VISION_DESCRIPTOR, third],
    });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    await service.download(third.modelId);
    expect(service.manager.statusOf(third.modelId)?.checksumVerified).toBe(true);
    await expect(service.remove(third.modelId)).rejects.toThrow(/no production runtime adapter/i);
    // The old Needle-vs-else branch would have unloaded Smol here.
    expect(p.calls).not.toContain("needle-unload");
    expect(service.manager.statusOf(NEEDLE_MODEL_ID)?.checksumVerified).toBe(true);
  });

  it("fails closed on web without constructing or contacting native seams", async () => {
    const service = new ApplicationAiService({ android: false });
    await service.ready;
    expect(() => service.offlineAdapter()).toThrow(/Android/);
    await expect(service.download(NEEDLE_MODEL_ID)).rejects.toThrow(/Android/);
  });
});
