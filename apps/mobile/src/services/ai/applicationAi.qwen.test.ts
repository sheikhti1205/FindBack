/**
 * W-A lane: Qwen3 0.6B production runtime ownership tests.
 *
 * Pins the composite text backend (Qwen prose + Needle structured),
 * single-resident arbitration across three engines, the epoch guard,
 * thought-stripping, the distribution gate, verify(), cancellation, and
 * fail-closed behavior without the native text plugin. Fakes only — no
 * network, no binaries; device inference proof stays an external blocker.
 */
import { describe, expect, it } from "vitest";
import {
  ApplicationAiService,
  compatibilityOf,
} from "./applicationAi";
import {
  QWEN_TEXT_DESCRIPTOR,
  QWEN_TEXT_MODEL_ID,
  QWEN_TEXT_RUNTIME_ID,
  NEEDLE_DESCRIPTOR,
  SMOL_VISION_DESCRIPTOR,
} from "./modelDescriptors";
import { NEEDLE_MODEL_ID } from "./needle/embedder";
import type { ModelDownloadDriver } from "./download/driver";
import type { OfflineVisionNativeBridge } from "./providers/offline";
import type { QwenTextBridge } from "./applicationAi";
import type { ModelDescriptor } from "./modelDescriptors";

function platform(options?: { qwenChunks?: string[]; qwenAvailable?: boolean }) {
  const disk = new Map<string, string>();
  const calls: string[] = [];
  const driver: ModelDownloadDriver = {
    rootDir: async () => "/private/ai-models",
    freeBytes: async () => 2_000_000_000,
    stagedSize: async (path) => (disk.has(path) ? 1 : 0),
    readJournalText: async () => null,
    download: async (attempt) => {
      calls.push(`download:${attempt.modelId ?? "?"}`);
      attempt.onProgress?.(20, null);
      disk.set(attempt.stagingPath, attempt.expectedSha256);
      return { receivedBytes: attempt.maxBytes, totalBytes: attempt.maxBytes, actualHex: attempt.expectedSha256, finalUrl: attempt.url };
    },
    cancelDownload: async () => {},
    hashFile: async (path) => { if (!disk.has(path)) throw new Error("missing"); return disk.get(path)!; },
    promoteFile: async (from, to) => { disk.set(to, disk.get(from)!); disk.delete(from); },
    removeFile: async (path) => { disk.delete(path); },
  };
  let needleResident = false;
  const needle = {
    bridgeName: "needle-cact" as const,
    isNeedleAvailable: async () => needleResident,
    embeddingDimension: async () => 2,
    loadModel: async () => { calls.push("needle-load"); needleResident = true; return 2; },
    embedNeedleTexts: async (texts: string[]) => texts.map(() => [1, 0]),
    initTools: async () => {},
    completeJson: async () => JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "red umbrella" } }] }),
    unload: async () => { calls.push("needle-unload"); needleResident = false; },
  };
  let visionLoaded = false;
  const smol: OfflineVisionNativeBridge & { collectDeviceFacts: () => Promise<Record<string, unknown>> } = {
    bridgeName: "smolvlm2-litertlm",
    isVisionAvailable: async () => visionLoaded,
    loadVisionModel: async () => { calls.push("vision-load"); visionLoaded = true; },
    unloadVisionModel: async () => { calls.push("vision-unload"); visionLoaded = false; },
    describeImage: async function* () { yield { textDelta: "A red umbrella." }; },
    cancelGeneration: async () => { calls.push("vision-cancel"); },
    collectDeviceFacts: async () => ({ supportedAbis: ["arm64-v8a"] }),
  };
  let qwenLoaded = false;
  const chunks = options?.qwenChunks ?? ["[thought]plan[/thought]You can find it at the desk."];
  const qwenAvailable = options?.qwenAvailable ?? true;
  const qwenText: QwenTextBridge = {
    bridgeName: "qwen3-litertlm-text",
    isTextAvailable: async () => qwenAvailable,
    loadTextModel: async () => { calls.push("qwen-load"); qwenLoaded = true; },
    unloadTextModel: async () => { calls.push("qwen-unload"); qwenLoaded = false; },
    generateText: async function* (request, signal) {
      calls.push(`qwen-generate:${request.generationId}`);
      for (const chunk of chunks) {
        if (signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (signal.aborted) return;
        yield { textDelta: chunk };
      }
    },
    cancelGeneration: async () => { calls.push("qwen-cancel"); },
  };
  return { disk, calls, driver, needle, smol, qwenText, qwenState: () => ({ qwenLoaded, needleResident, visionLoaded }) };
}

describe("Qwen production runtime", () => {
  it("routes prose through Qwen with real provenance and stripped reasoning", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(QWEN_TEXT_MODEL_ID);
    const result = await service.route("answer-help", { prompt: "Where is my umbrella?" }, { traceId: "trace-qwen-prose" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.modelId).toBe(QWEN_TEXT_MODEL_ID);
      expect(result.provenance.runtimeId).toBe(QWEN_TEXT_RUNTIME_ID);
      const value = result.value as { answerText?: string };
      expect(value.answerText ?? "").toContain("desk");
      expect(value.answerText ?? "").not.toContain("[thought]");
      expect(value.answerText ?? "").not.toContain("plan");
    }
    expect(p.calls).toContain("qwen-load");
    expect(service.residency.owner).toBe("qwen-text");
  });

  it("keeps structured extraction on Needle with Needle provenance", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(QWEN_TEXT_MODEL_ID);
    await service.download(NEEDLE_MODEL_ID);
    const result = await service.route("extract-report-fields", { prompt: "title: red umbrella" }, { traceId: "trace-needle-structured" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.modelId).toBe(NEEDLE_MODEL_ID);
      expect(result.provenance.runtimeId).toBe("needle-cact");
    }
  });

  it("falls back to Needle prose on builds without the text plugin (today's behavior preserved)", async () => {
    const p = platform();
    const { qwenText: _dropped, ...rest } = p;
    void _dropped;
    const service = new ApplicationAiService({ android: true, ...rest });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    const result = await service.route("extract-report-fields", { prompt: "title: keys" }, { traceId: "trace-needle-only" });
    expect(result.ok).toBe(true);
  });

  it("arbitrates a single resident: vision load evicts Qwen and Qwen load evicts vision", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(QWEN_TEXT_MODEL_ID);
    await service.download(SMOL_VISION_DESCRIPTOR.modelId);
    await service.route("answer-help", { prompt: "hi" }, { traceId: "trace-resident-qwen" });
    expect(service.residency.owner).toBe("qwen-text");
    await service.route("analyze-image", { prompt: "describe", imageBase64: "aGVsbG8=" }, { traceId: "trace-resident-vision" });
    expect(service.residency.owner).toBe("smol-vision");
    expect(p.calls).toContain("qwen-unload");
    await service.route("answer-help", { prompt: "hi again" }, { traceId: "trace-resident-qwen-2" });
    expect(service.residency.owner).toBe("qwen-text");
    expect(p.calls).toContain("vision-unload");
  });

  it("refuses Advanced downloads with the consumer legal reason and no transport", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    const advanced = service.registry.advancedCatalogue()[0]!;
    expect(advanced.downloadable).toBe(false);
    await expect(service.download(advanced.modelId)).rejects.toThrow();
    expect(service.notice(advanced.modelId)).toBe(advanced.distributionNote);
    expect(p.calls.some((call) => call.startsWith("download:"))).toBe(false);
    expect(service.manager.statusOf(advanced.modelId)?.download).toBe("not-installed");
  });

  it("verifies installs: match keeps the model, mismatch drops the install claim", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(QWEN_TEXT_MODEL_ID);
    await service.verify(QWEN_TEXT_MODEL_ID);
    expect(service.manager.statusOf(QWEN_TEXT_MODEL_ID)?.download).toBe("installed");
    // Corrupt the installed bytes behind the manager's back.
    for (const path of p.disk.keys()) p.disk.set(path, "0".repeat(64));
    await service.verify(QWEN_TEXT_MODEL_ID);
    expect(service.manager.statusOf(QWEN_TEXT_MODEL_ID)?.download).toBe("not-installed");
    expect(service.notice(QWEN_TEXT_MODEL_ID)).toMatch(/verification/i);
    const adapter = service.offlineAdapter();
    const models = await adapter.listModels?.();
    expect(models?.some((record) => record.id === QWEN_TEXT_MODEL_ID)).toBe(false);
  });

  it("streams offline chat through Qwen with stripped thought envelopes", async () => {
    const p = platform({ qwenChunks: ["Hello [thought]hidden", " reasoning[/thought] world"] });
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(QWEN_TEXT_MODEL_ID);
    const adapter = service.offlineAdapter();
    const events: Array<{ kind: string; delta?: string; code?: string }> = [];
    for await (const event of adapter.complete({
      selection: { accountId: "u", provider: "offline", modelId: QWEN_TEXT_MODEL_ID, mode: "free-only" },
      task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
      currentText: "Hi", approvedImageIds: [], authorizedResultIds: [], maxOutputTokens: 64,
      signal: new AbortController().signal,
    })) events.push(event as { kind: string; delta?: string; code?: string });
    const text = events.filter((event) => event.kind === "text").map((event) => event.delta ?? "").join("");
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).not.toContain("thought");
    expect(text).not.toContain("hidden");
    expect(events.some((event) => event.kind === "error")).toBe(false);
  });

  it("fails the offline chat closed for unknown models and uninstalled builds", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    const adapter = service.offlineAdapter();
    const run = async (modelId: string) => {
      const events: Array<{ kind: string; code?: string }> = [];
      for await (const event of adapter.complete({
        selection: { accountId: "u", provider: "offline", modelId, mode: "free-only" },
        task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
        currentText: "hi", approvedImageIds: [], authorizedResultIds: [], maxOutputTokens: 64,
        signal: new AbortController().signal,
      })) events.push(event as { kind: string; code?: string });
      return events.find((event) => event.kind === "error")?.code;
    };
    expect(await run("no-such-model")).toBe("unknown_model");
    expect(await run(QWEN_TEXT_MODEL_ID)).toBe("model_not_installed");
  });

  it("cancels a Qwen stream natively without falling back anywhere", async () => {
    const p = platform({ qwenChunks: ["chunk-one ", "chunk-two ", "chunk-three"] });
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(QWEN_TEXT_MODEL_ID);
    const adapter = service.offlineAdapter();
    const controller = new AbortController();
    const events: Array<{ kind: string; stopReason?: string; code?: string; delta?: string }> = [];
    const stream = adapter.complete({
      selection: { accountId: "u", provider: "offline", modelId: QWEN_TEXT_MODEL_ID, mode: "free-only" },
      task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
      currentText: "Tell me a long story", approvedImageIds: [], authorizedResultIds: [], maxOutputTokens: 64,
      signal: controller.signal,
    });
    for await (const event of stream) {
      events.push(event as { kind: string; stopReason?: string; code?: string; delta?: string });
      // Abort once generation has produced text: the abort must cancel the
      // native generation and surface nothing further.
      if (event.kind === "text") controller.abort();
    }
    const texts = events.filter((event) => event.kind === "text");
    // The envelope filter holds a partial-marker tail, so the first emission
    // is a prefix — what matters here is that the abort stops everything.
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect(texts.map((event) => event.delta ?? "").join("")).not.toContain("chunk-three");
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(p.calls).toContain("qwen-cancel");
    // Cancel never retries or falls back: exactly one native generation ran.
    expect(p.calls.filter((call) => call.startsWith("qwen-generate:"))).toHaveLength(1);
  });

  it("refuses a second route while a Qwen stream holds the lease, leaving the stream intact", async () => {
    const p = platform({ qwenChunks: ["first ", "second ", "third"] });
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(QWEN_TEXT_MODEL_ID);
    await service.download(SMOL_VISION_DESCRIPTOR.modelId);
    const adapter = service.offlineAdapter(async () => "approved-bytes");
    const controller = new AbortController();
    const seen: string[] = [];
    const stream = adapter.complete({
      selection: { accountId: "u", provider: "offline", modelId: QWEN_TEXT_MODEL_ID, mode: "free-only" },
      task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
      currentText: "stream please", approvedImageIds: [], authorizedResultIds: [], maxOutputTokens: 64,
      signal: controller.signal,
    });
    let refused = false;
    for await (const event of stream) {
      if (event.kind === "text") {
        seen.push((event as { delta: string }).delta);
        // A resident switch mid-stream is refused while the lease is held:
        // the in-flight generation keeps its resident, never half-switched.
        await expect(
          service.route("analyze-image", { prompt: "describe", imageBase64: "aGVsbG8=" }, { traceId: "trace-epoch-switch" }),
        ).rejects.toThrow(/busy/);
        refused = true;
      }
      if (event.kind === "done") break;
    }
    expect(refused).toBe(true);
    expect(service.residency.owner).toBe("qwen-text");
    expect(seen.join("")).toBe("first second third");
  });

  it("loads the Qwen resident once across consecutive streams (no reload churn)", async () => {
    const p = platform({ qwenChunks: ["hello"] });
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(QWEN_TEXT_MODEL_ID);
    const adapter = service.offlineAdapter();
    const run = async () => {
      for await (const _event of adapter.complete({
        selection: { accountId: "u", provider: "offline", modelId: QWEN_TEXT_MODEL_ID, mode: "free-only" },
        task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
        currentText: "hi", approvedImageIds: [], authorizedResultIds: [], maxOutputTokens: 64,
        signal: new AbortController().signal,
      })) { /* drain */ }
    };
    await run();
    await run();
    expect(p.calls.filter((call) => call === "qwen-load")).toHaveLength(1);
  });

  it("account reset aborts a Qwen stream and unloads only after settlement", async () => {
    const p = platform({ qwenChunks: ["one ", "two ", "three"] });
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(QWEN_TEXT_MODEL_ID);
    const adapter = service.offlineAdapter();
    const events: Array<{ kind: string; stopReason?: string }> = [];
    const stream = adapter.complete({
      selection: { accountId: "u", provider: "offline", modelId: QWEN_TEXT_MODEL_ID, mode: "free-only" },
      task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
      currentText: "long story", approvedImageIds: [], authorizedResultIds: [], maxOutputTokens: 64,
      signal: new AbortController().signal,
    });
    let resetting: Promise<void> | undefined;
    for await (const event of stream) {
      events.push(event as { kind: string; stopReason?: string });
      if (resetting === undefined && event.kind === "text") resetting = service.resetForAccount();
    }
    await resetting;
    // The reset aborted the visible stream (it ends without completing),
    // the native generation was cancelled, and post-settlement cleanup
    // unloaded the engine while keeping the verified files.
    expect(events.some((event) => event.kind === "error")).toBe(false);
    expect(p.calls).toContain("qwen-cancel");
    expect(p.calls).toContain("qwen-unload");
    expect(service.residency).toMatchObject({ owner: "none", claimed: false, inflight: 0 });
    expect(service.manager.statusOf(QWEN_TEXT_MODEL_ID)?.checksumVerified).toBe(true);
  });

  it("compatibilityOf requires the matching bridge per runtime, never a bare format", () => {
    const abis = ["arm64-v8a"];
    const full = { needle: true, smol: true, qwenText: true, llama: false };
    expect(compatibilityOf(QWEN_TEXT_DESCRIPTOR, abis, full).compatible).toBe(true);
    expect(compatibilityOf(QWEN_TEXT_DESCRIPTOR, abis, { needle: true, smol: true }).compatible).toBe(false);
    expect(compatibilityOf(SMOL_VISION_DESCRIPTOR, abis, { needle: true, smol: false, qwenText: true }).compatible).toBe(false);
    expect(compatibilityOf(NEEDLE_DESCRIPTOR, abis, { needle: false, smol: true, qwenText: true }).compatible).toBe(false);
    expect(compatibilityOf(QWEN_TEXT_DESCRIPTOR, ["x86_64"], full).compatible).toBe(false);
    const gguf: ModelDescriptor = {
      modelId: "test-gguf", displayName: "Test", consumerTitle: "Test", consumerDetail: "Test",
      runtimeId: "llamacpp-gguf", format: "gguf", revision: "r", sha256: "s", fileName: "t.gguf",
      url: "", bytes: 0, capabilities: ["text"], taskRoles: [], maturity: "lab", trust: "curated",
      license: "lfm-1.0-eval-only", minRamMb: 512, recommendedRamMb: 512, abis: ["arm64-v8a"], downloadable: false,
    };
    expect(compatibilityOf(gguf, abis, full).compatible).toBe(false);
  });

  it("survives rapid resident switching with one owner and no stale results", async () => {
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(QWEN_TEXT_MODEL_ID);
    await service.download(SMOL_VISION_DESCRIPTOR.modelId);
    for (let round = 0; round < 3; round += 1) {
      const text = await service.route("answer-help", { prompt: `round ${round}` }, { traceId: `trace-rapid-text-${round}` });
      expect(text.ok).toBe(true);
      expect(service.residency.owner).toBe("qwen-text");
      const vision = await service.route("analyze-image", { prompt: "describe", imageBase64: "aGVsbG8=" }, { traceId: `trace-rapid-vision-${round}` });
      expect(vision.ok).toBe(true);
      expect(service.residency.owner).toBe("smol-vision");
    }
    // Every switch evicted the previous resident; no generation leaked
    // across rounds and the gate is free afterwards.
    expect(p.calls.filter((call) => call === "qwen-load")).toHaveLength(3);
    expect(p.calls.filter((call) => call === "vision-load")).toHaveLength(3);
    expect(service.residency).toMatchObject({ claimed: false, inflight: 0 });
  });

  it("survives process restart for Qwen installs and drops Qwen on account reset without wiping files", async () => {
    const p = platform();
    const first = new ApplicationAiService({ android: true, ...p });
    await first.ready;
    await first.download(QWEN_TEXT_MODEL_ID);
    const second = new ApplicationAiService({ android: true, ...p });
    await second.ready;
    expect(second.manager.statusOf(QWEN_TEXT_MODEL_ID)?.checksumVerified).toBe(true);
    await second.route("answer-help", { prompt: "hi" }, { traceId: "trace-restart" });
    expect(second.residency.owner).toBe("qwen-text");
    await second.resetForAccount();
    expect(second.residency).toMatchObject({ owner: "none", claimed: false, inflight: 0 });
    expect(p.calls).toContain("qwen-unload");
    expect(second.manager.statusOf(QWEN_TEXT_MODEL_ID)?.checksumVerified).toBe(true);
  });

  it("keeps Qwen downloads offline-isolated: no fetch, no endpoint, no URL contact on the local path", async () => {
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      fetchCalls.push(typeof input === "string" ? input : "request");
      throw new Error("network disabled in local-only mode");
    }) as typeof fetch;
    try {
      const p = platform();
      const service = new ApplicationAiService({ android: true, ...p });
      await service.ready;
      await service.download(QWEN_TEXT_MODEL_ID);
      const result = await service.route("answer-help", { prompt: "offline check" }, { traceId: "trace-offline-isolation" });
      expect(result.ok).toBe(true);
      // The driver fake records every transport call; inference adds none,
      // and no fetch piles on from any layer of the local path.
      expect(p.calls.filter((call) => call.startsWith("download:"))).toHaveLength(1);
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
