import { describe, expect, it, vi } from "vitest";
import { ApplicationAiService, compatibilityOf, DEVICE_CORPUS_VERSION, DEVICE_INCOMPATIBLE_REASON, type QwenTextBridge } from "./applicationAi";
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
  // Every android build ships the Smol facts bridge; the platform fake
  // carries it separately so the base seam type stays untouched.
  const smolWithFacts = {
    ...smol,
    collectDeviceFacts: async (): Promise<Record<string, unknown>> => ({ supportedAbis: ["arm64-v8a"] }),
  };
  // W-A: the LiteRT-LM text seam is a first-class injected bridge, faked
  // here like Needle and Smol (production android builds the Capacitor
  // FindbackQwenText bridge instead).
  const qwenText: QwenTextBridge = {
    bridgeName: "qwen3-litertlm-text",
    isTextAvailable: async () => false,
    loadTextModel: async () => { calls.push("qwen-load"); },
    unloadTextModel: async () => { calls.push("qwen-unload"); },
    generateText: async function* () { yield { textDelta: "qwen answer" }; },
    cancelGeneration: async () => { calls.push("qwen-cancel"); },
  };
  return { disk, calls, driver, needle, smol: smolWithFacts, qwenText };
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

  it("claims the model before the first await, so a second tap cannot start a second transfer", async () => {
    // The device registers a transfer a tick AFTER the click, so two taps
    // inside that window used to reach the ownership checks together and
    // could both register a transfer against the same staging path. The
    // claim makes the second request a no-op, and `busy()` reports it so
    // the surface that owns the button can disable it.
    const p = platform();
    let release!: () => void;
    p.driver.download = async (attempt) => {
      p.calls.push("download");
      await new Promise<void>((resolve) => { release = resolve; });
      return {
        receivedBytes: attempt.maxBytes,
        totalBytes: attempt.maxBytes,
        actualHex: attempt.expectedSha256,
        finalUrl: attempt.url,
      };
    };
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    const id = NEEDLE_DESCRIPTOR.modelId;

    const first = service.download(id);
    // The claim is taken synchronously — before the first await — so the
    // row knows the device is busy with the request itself.
    expect(service.busy(id)).toBe(true);

    // The second request is refused at once and never reaches the device.
    await service.download(id);
    await vi.waitFor(() => expect(p.calls.filter(call => call === "download")).toHaveLength(1));
    release();
    await first;

    expect(p.calls.filter(call => call === "download")).toHaveLength(1);
    expect(service.busy(id)).toBe(false);
  });

  it("releases the claim when the attempt fails, so a retry is never refused", async () => {
    const p = platform();
    let attempts = 0;
    p.driver.download = async () => {
      attempts += 1;
      throw new Error("network is down");
    };
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    const id = NEEDLE_DESCRIPTOR.modelId;

    await service.download(id);
    expect(attempts).toBe(1);
    expect(service.busy(id)).toBe(false);

    // The retry reaches the device: a failed attempt must not leave the
    // model claimed forever.
    await service.download(id);
    expect(attempts).toBe(2);
  });

  it("notifies subscribers when a claim is released before any transfer exists", async () => {
    // A claim that never reaches the device — an already-aborted signal, an
    // invalid mirror, a reset crossing the prerequisites, an incompatible
    // runtime — must still publish its release. Otherwise the row stays
    // disabled on a busy flag that a direct `busy()` read already reports as
    // false, and the surface never learns the attempt is over.
    const p = platform();
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    const id = NEEDLE_DESCRIPTOR.modelId;
    const observed: boolean[] = [];
    const versions: number[] = [];
    const unsubscribe = service.subscribe(() => {
      observed.push(service.busy(id));
      versions.push(service.snapshot());
    });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(service.download(id, undefined, controller.signal)).rejects.toThrow(/cancel/i);
    } finally {
      unsubscribe();
    }
    // The claim was observed, then its release was published: the LAST event
    // a subscriber saw is `not busy`, and the snapshot moved with it.
    expect(observed.length).toBeGreaterThanOrEqual(2);
    expect(observed[0]).toBe(true);
    expect(observed.at(-1)).toBe(false);
    expect(new Set(versions).size).toBe(versions.length);
    expect(service.busy(id)).toBe(false);
    expect(p.calls).not.toContain("download");
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

  it("maps benchmark_unavailable to a CPU-usable notice instead of a collapsed timing error", async () => {
    const p = platform();
    const failure = Object.assign(new Error("counters off"), { code: "benchmark_unavailable" });
    const smol = {
      ...p.smol,
      measureBackend: async () => { throw failure; },
    };
    const service = new ApplicationAiService({ android: true, ...p, smol });
    await service.ready;
    await service.download(SMOL_VISION_DESCRIPTOR.modelId);
    await expect(service.measure("cpu")).rejects.toThrow(/Measurement failed.*benchmark_unavailable/);
    expect(service.notice(SMOL_VISION_DESCRIPTOR.modelId)).toMatch(/CPU inference remains usable/);
  });

  it("tracks single-resident ownership across loads and account reset", async () => {    const p = platform();
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
      defaultVisionModelId: SMOL_VISION_DESCRIPTOR.modelId,
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
      consumerTitle: "Test third",
      consumerDetail: "Test",
      runtimeId: "test-unowned-runtime",
      format: "cact",
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
      downloadable: true,
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

  it("holds the runtime lease until orphaned native work settles after a timeout", async () => {
    const p = platform();
    const releasers: Array<() => void> = [];
    let calls = 0;
    // First native call never settles on its own (ignores AbortSignal);
    // later calls resolve immediately with a valid tool envelope.
    p.needle.completeJson = async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => { releasers.push(resolve); });
      }
      return JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "red umbrella" } }] });
    };
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    const timedOut = await service.route(
      "extract-report-fields",
      { prompt: "a red umbrella" },
      { traceId: "trace-settle-timeout", timeoutMs: 50 },
    );
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.denialReason).toBe("TIMEOUT");
    // Caller got TIMEOUT, but native is still running: the next operation
    // (and a residency switch) must still be refused.
    await expect(
      service.route("extract-report-fields", { prompt: "keys" }, { traceId: "trace-settle-refused" }),
    ).rejects.toThrow(/busy/);
    await expect(service.remove(NEEDLE_MODEL_ID)).rejects.toThrow(/busy/);
    releasers.forEach((release) => release());
    // Let the settlement chain drain (native resolve → adapter → lease)
    // before the next flight may begin.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const recovered = await service.route(
      "extract-report-fields",
      { prompt: "title: keys" },
      { traceId: "trace-settle-recovered" },
    );
    expect(recovered.ok).toBe(true);
  });
  it("logout aborts the actual route signal, unloads only after native settles, and never delivers stale results", async () => {    const p = platform();
    const releasers: Array<() => void> = [];
    const unloads: string[] = [];
    let calls = 0;
    p.needle.completeJson = async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => { releasers.push(resolve); });
      }
      return JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "red umbrella" } }] });
    };
    const baseUnload = p.needle.unload;
    p.needle.unload = async () => { unloads.push("needle-unload"); await baseUnload(); };
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    const flight = service.route(
      "extract-report-fields",
      { prompt: "a red umbrella" },
      { traceId: "trace-logout-flight", timeoutMs: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const resetting = service.resetForAccount();
    const result = await flight;
    // The orphaned route reports cancellation, never success for account B.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denialReason).toBe("CANCELLED");
    // Native still unsettled: the engine must NOT be unloaded yet, and the
    // gate stays busy across the account change.
    expect(unloads).toEqual([]);
    await expect(
      service.route("extract-report-fields", { prompt: "keys" }, { traceId: "trace-logout-refused" }),
    ).rejects.toThrow(/busy/);
    releasers.forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 0));
    await resetting;
    // Settlement first, unload second — never torn down mid-execution.
    expect(unloads).toEqual(["needle-unload"]);
    const after = await service.route(
      "extract-report-fields",
      { prompt: "title: keys" },
      { traceId: "trace-logout-after" },
    );
    expect(after.ok).toBe(true);
  });

  it("grades device compatibility on ABI, runtime presence, and format support", () => {    const bridges = { needle: true, smol: true };
    expect(compatibilityOf(NEEDLE_DESCRIPTOR, ["arm64-v8a"], bridges)).toEqual({ compatible: true });
    expect(compatibilityOf(SMOL_VISION_DESCRIPTOR, ["arm64-v8a", "x86_64"], bridges).compatible).toBe(true);
    // Unsupported ABI (e.g. the armeabi-v7a/x86_64 APK on an unvalidated
    // device) is refused, even though the platform is Android.
    expect(compatibilityOf(NEEDLE_DESCRIPTOR, ["x86_64"], bridges)).toEqual({
      compatible: false,
      reason: DEVICE_INCOMPATIBLE_REASON,
    });
    // Unreadable facts fail closed: empty never counts as compatible.
    expect(compatibilityOf(NEEDLE_DESCRIPTOR, [], bridges).compatible).toBe(false);
    // Missing native runtime for the artifact format is refused.
    expect(compatibilityOf(NEEDLE_DESCRIPTOR, ["arm64-v8a"], { needle: false, smol: true }).compatible).toBe(false);
    expect(compatibilityOf(SMOL_VISION_DESCRIPTOR, ["arm64-v8a"], { needle: true, smol: false }).compatible).toBe(false);
  });

  it("refuses downloads on ABI-incompatible Android without staging bytes", async () => {
    const p = platform();
    const x86smol = {
      ...p.smol,
      collectDeviceFacts: async (): Promise<Record<string, unknown>> => ({ supportedAbis: ["x86_64"] }),
    };
    const service = new ApplicationAiService({ android: true, driver: p.driver, needle: p.needle, smol: x86smol, qwenText: p.qwenText });
    await service.ready;
    await expect(service.download(NEEDLE_MODEL_ID)).rejects.toThrow(DEVICE_INCOMPATIBLE_REASON);
    expect(service.notice(NEEDLE_MODEL_ID)).toBe(DEVICE_INCOMPATIBLE_REASON);
    expect(p.calls).not.toContain("download");
    expect(service.manager.statusOf(NEEDLE_MODEL_ID)?.download).toBe("not-installed");
  });

  it("refuses to run an installed model after the device proves incompatible", async () => {
    const p = platform();
    const first = new ApplicationAiService({ android: true, ...p });
    await first.ready;
    await first.download(NEEDLE_MODEL_ID);
    // Same files, but the device now reports an unverified ABI.
    const x86smol = {
      ...p.smol,
      collectDeviceFacts: async (): Promise<Record<string, unknown>> => ({ supportedAbis: ["x86_64"] }),
    };
    const second = new ApplicationAiService({ android: true, driver: p.driver, needle: p.needle, smol: x86smol, qwenText: p.qwenText });
    await second.ready;
    expect(second.manager.statusOf(NEEDLE_MODEL_ID)?.checksumVerified).toBe(true);
    await expect(second.embedNeedle(["umbrella"])).rejects.toThrow(/not installed and verified|not resident/);
  });

  it.each([NEEDLE_MODEL_ID, SMOL_VISION_DESCRIPTOR.modelId])("refuses direct offline prose for non-chat engine %s without calling native engines", async (modelId) => {
    const p = platform();
    const extract = vi.spyOn(p.needle, "completeJson");
    const needleLoad = vi.spyOn(p.needle, "loadModel");
    const vision = vi.spyOn(p.smol, "describeImage");
    const visionLoad = vi.spyOn(p.smol, "loadVisionModel");
    const qwenGenerate = vi.spyOn(p.qwenText, "generateText");
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    await service.download(SMOL_VISION_DESCRIPTOR.modelId);
    const resolveImage = vi.fn(async () => "approved-bytes");
    const adapter = service.offlineAdapter(resolveImage);
    const request = {
      selection: { accountId: "u", provider: "offline", modelId, mode: "free-only" },
      task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
      currentText: "How do I report a lost umbrella?", approvedImageIds: [], authorizedResultIds: [],
      maxOutputTokens: 64, signal: new AbortController().signal,
    } as Parameters<typeof adapter.complete>[0];
    const events = [];
    for await (const event of adapter.complete(request)) events.push(event);
    // The offline chat seam is Qwen-only (explicit model id): a structured
    // tool id or a vision id fails closed as a load failure, never as chat.
    expect(events).toEqual([
      { kind: "phase", phase: "queued", attempt: 1 },
      { kind: "phase", phase: "failed", attempt: 1, message: "runtime_load_failed" },
      { kind: "error", attempt: 1, code: "runtime_load_failed", retryable: false,
        message: `unknown model ${modelId}` },
      { kind: "done", attempt: 1, stopReason: "error" },
    ]);
    expect(extract).not.toHaveBeenCalled();
    expect(needleLoad).not.toHaveBeenCalled();
    expect(vision).not.toHaveBeenCalled();
    expect(visionLoad).not.toHaveBeenCalled();
    expect(qwenGenerate).not.toHaveBeenCalled();
    expect(resolveImage).not.toHaveBeenCalled();
    expect(service.residency).toMatchObject({ owner: "none", claimed: false, inflight: 0 });
    expect(service.manager.statusOf(modelId)?.checksumVerified).toBe(true);
  });

  it("logout cancels a pending offline vision provider through true native cancel", async () => {
    const p = platform();
    const cancels: string[] = [];
    const visionSmol = {
      ...p.smol,
      isVisionAvailable: async () => true,
      loadVisionModel: async () => {},
      describeImage: async function* (_request: unknown, signal: AbortSignal) {
        // Hang until the combined signal aborts the native call (true
        // cancel path). The abort rejection below ends the stream with
        // zero text delivered; the trailing yield is unreachable by
        // construction and exists only to satisfy require-yield.
        await new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("vision aborted")), { once: true });
        });
        yield { textDelta: "" };
      },
      cancelGeneration: async () => { cancels.push("cancel"); },
    };
    const service = new ApplicationAiService({ android: true, ...p, smol: visionSmol });
    await service.ready;
    await service.download(SMOL_VISION_DESCRIPTOR.modelId);
    const adapter = service.offlineAdapter(async () => "aGVsbG8=");
    const caller = new AbortController();
    const request = {
      selection: { accountId: "u", provider: "offline", modelId: SMOL_VISION_DESCRIPTOR.modelId, mode: "free-only" },
      task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
      currentText: "Describe", approvedImageIds: ["img-1"], authorizedResultIds: [],
      maxOutputTokens: 64, signal: caller.signal,
    } as Parameters<typeof adapter.complete>[0];
    const events: unknown[] = [];
    const consuming = (async () => {
      for await (const event of adapter.complete(request)) events.push(event);
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.resetForAccount();
    await Promise.race([
      consuming,
      new Promise((_, reject) => setTimeout(() => reject(new Error("vision stream hung past logout")), 2000)),
    ]);
    // True native cancel ran, and no image text reached the old account.
    expect(cancels).toEqual(["cancel"]);
    expect(events.filter((event) => (event as { kind?: string }).kind === "text")).toEqual([]);
  });

  it("reset never unloads under native work that outlives the sign-out wait", async () => {
    const p = platform();
    const releasers: Array<() => void> = [];
    const unloads: string[] = [];
    let calls = 0;
    p.needle.completeJson = async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => { releasers.push(resolve); });
      }
      return JSON.stringify({ function_calls: [{ name: "record_item", arguments: { title: "red umbrella" } }] });
    };
    const baseUnload = p.needle.unload;
    p.needle.unload = async () => { unloads.push("needle-unload"); await baseUnload(); };
    const service = new ApplicationAiService({ android: true, ...p });
    await service.ready;
    await service.download(NEEDLE_MODEL_ID);
    await service.download(SMOL_VISION_DESCRIPTOR.modelId);
    const flight = service.route(
      "extract-report-fields",
      { prompt: "a red umbrella" },
      { traceId: "trace-barrier-flight", timeoutMs: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Bound far below any real hang: the wait MUST expire with native alive.
    const resetting = service.resetForAccount(100);
    const result = await flight;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denialReason).toBe("CANCELLED");
    // Sign-out itself finishes...
    await resetting;
    // ...but no engine was torn down under live native work...
    expect(unloads).toEqual([]);
    // ...and the barrier refuses route, removal, and measurement.
    await expect(
      service.route("extract-report-fields", { prompt: "keys" }, { traceId: "trace-barrier-refused" }),
    ).rejects.toThrow(/busy/);
    await expect(service.remove(NEEDLE_MODEL_ID)).rejects.toThrow(/busy/);
    await expect(service.measure("cpu")).rejects.toThrow(/busy/);
    // Settlement triggers the deferred cleanup: unload AFTER settle...
    releasers.forEach((release) => release());
    const deadline = Date.now() + 2000;
    while (unloads.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(unloads).toEqual(["needle-unload"]);
    // ...and the barrier clears: the next account can route again.
    const after = await service.route(
      "extract-report-fields",
      { prompt: "title: keys" },
      { traceId: "trace-barrier-after" },
    );
    expect(after.ok).toBe(true);
  });
});
