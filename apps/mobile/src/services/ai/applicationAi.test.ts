import { describe, expect, it } from "vitest";
import { ApplicationAiService, DEVICE_CORPUS_VERSION, DOWNLOAD_MODELS } from "./applicationAi";
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
    await service.download(DOWNLOAD_MODELS[0].modelId);
    await service.download(DOWNLOAD_MODELS[1].modelId);
    let release!: () => void;
    let entered!: () => void;
    const unloading = new Promise<void>((resolve) => { entered = resolve; });
    p.needle.unload = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); };
    const removal = service.remove(DOWNLOAD_MODELS[0].modelId);
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
    const modelId = DOWNLOAD_MODELS[1].modelId;
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
    const id = DOWNLOAD_MODELS[0]!.modelId;
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
    const id = DOWNLOAD_MODELS[0]!.modelId;
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
    const modelId = DOWNLOAD_MODELS[1]!.modelId;
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

  it("fails closed on web without constructing or contacting native seams", async () => {
    const service = new ApplicationAiService({ android: false });
    await service.ready;
    expect(() => service.offlineAdapter()).toThrow(/Android/);
    await expect(service.download(DOWNLOAD_MODELS[0]!.modelId)).rejects.toThrow(/Android/);
  });
});
