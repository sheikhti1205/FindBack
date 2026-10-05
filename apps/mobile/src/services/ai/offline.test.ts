/**
 * Offline provider adapter + model manager tests (AI-023).
 *
 * No network, no model binaries, no native bridge here: every seam past the
 * TypeScript boundary (transport, SHA-256, storage probe, LiteRT/llama.cpp
 * bridge) is a hand-built fake. Nothing in this file downloads anything.
 */
import { describe, expect, it, vi } from "vitest";
import {
  OFFLINE_MANAGER_SNAPSHOT_VERSION,
  OfflineModelManager,
  createInitialStatus,
  transitionOfflineModel,
  type OfflineAssetPin,
  type OfflineManagerSnapshot,
  type OfflineModelStatus,
} from "./offlineModelManager";
import {
  OFFLINE_PROVIDER_ID,
  createOfflineAdapter,
  type OfflineAdapterDeps,
  type OfflineNativeBridge,
  type OfflineVisionNativeBridge,
} from "./providers/offline";
import type { NormalizedRequest, StreamEvent } from "./providerContract";

const PIN: OfflineAssetPin = {
  modelId: "qwen3-0.6b-dynamic-int4",
  sha256: "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
  downloadBytes: 600_000_000,
  minFreeRamMb: 1500,
};

const FAILING_BRIDGE: OfflineNativeBridge = {
  bridgeName: "test-stub",
  isAvailable: () => false,
  load: async () => {},
  unload: async () => {},
  generate: async function* () {},
};

function controllableBridge(chunks: string[]): OfflineNativeBridge & {
  loads: string[];
  generates: number;
} {
  const state = { loads: [] as string[], generates: 0 };
  return {
    loads: state.loads,
    get generates() {
      return state.generates;
    },
    bridgeName: "test-stub",
    isAvailable: () => true,
    load: async (modelId: string) => {
      state.loads.push(modelId);
    },
    unload: async () => {},
    generate: async function* (_prompt: unknown, _signal: AbortSignal) {
      state.generates += 1;
      for (const chunk of chunks) yield { textDelta: chunk };
    },
  };
}

function installedManager(opts?: { resident?: boolean }): OfflineModelManager {
  const manager = new OfflineModelManager([PIN]);
  manager.dispatch(PIN.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
  manager.dispatch(PIN.modelId, { type: "START" });
  manager.dispatch(PIN.modelId, { type: "PROGRESS", downloadedBytes: PIN.downloadBytes });
  manager.dispatch(PIN.modelId, { type: "VERIFY_START" });
  manager.dispatch(PIN.modelId, {
    type: "VERIFY_OK",
    actualSha256: PIN.sha256,
  });
  if (opts?.resident === true) {
    manager.dispatch(PIN.modelId, { type: "LOAD" });
    manager.dispatch(PIN.modelId, { type: "LOADED" });
  }
  return manager;
}

function baseRequest(overrides: Partial<NormalizedRequest> = {}): {
  request: NormalizedRequest;
  controller: AbortController;
} {
  const controller = new AbortController();
  return {
    controller,
    request: {
      selection: {
        accountId: "acct-1",
        provider: OFFLINE_PROVIDER_ID,
        modelId: PIN.modelId,
        mode: "free-only",
      },
      task: "app-help",
      policyVersion: "p1",
      knowledgeVersion: "k1",
      recentTurns: [],
      currentText: "Hello",
      approvedImageIds: [],
      authorizedResultIds: [],
      maxOutputTokens: 128,
      signal: controller.signal,
      ...overrides,
    },
  };
}

async function collect(
  iterable: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function errorOf(events: StreamEvent[]): { code: string; retryable: boolean } {
  const error = events.find((event) => event.kind === "error");
  expect(error?.kind).toBe("error");
  const payload = error as Extract<StreamEvent, { kind: "error" }>;
  return { code: payload.code, retryable: payload.retryable };
}

describe("offline model manager state machine", () => {
  it("starts not-installed and unloaded", () => {
    const status = createInitialStatus(PIN);
    expect(status.download).toBe("not-installed");
    expect(status.residency).toBe("unloaded");
    expect(status.downloadedBytes).toBe(0);
    expect(status.checksumVerified).toBe(false);
  });

  it("refuses to queue a download that is not explicitly user-initiated", () => {
    const status = createInitialStatus(PIN);
    expect(() =>
      transitionOfflineModel(status, { type: "QUEUE_DOWNLOAD", userInitiated: false }),
    ).toThrow(/user-initiated/i);
  });

  it("runs the full download lifecycle to installed", () => {
    let status = createInitialStatus(PIN);
    status = transitionOfflineModel(status, {
      type: "QUEUE_DOWNLOAD",
      userInitiated: true,
    });
    expect(status.download).toBe("queued");
    status = transitionOfflineModel(status, { type: "START" });
    status = transitionOfflineModel(status, {
      type: "PROGRESS",
      downloadedBytes: 100,
    });
    expect(status.downloadedBytes).toBe(100);
    status = transitionOfflineModel(status, { type: "VERIFY_START" });
    expect(status.download).toBe("verifying");
    status = transitionOfflineModel(status, {
      type: "VERIFY_OK",
      actualSha256: PIN.sha256,
    });
    expect(status.download).toBe("installed");
    expect(status.checksumVerified).toBe(true);
  });

  it("rejects a checksum mismatch and never reports installed", () => {
    let status = createInitialStatus(PIN);
    status = transitionOfflineModel(status, {
      type: "QUEUE_DOWNLOAD",
      userInitiated: true,
    });
    status = transitionOfflineModel(status, { type: "START" });
    status = transitionOfflineModel(status, { type: "VERIFY_START" });
    status = transitionOfflineModel(status, {
      type: "VERIFY_FAIL",
      reason: "hash mismatch",
    });
    expect(status.download).toBe("failed");
    expect(status.checksumVerified).toBe(false);
    expect(status.lastError).toMatch(/hash mismatch/);
  });

  it("pauses and resumes without losing staged bytes, and cancels back to a resumable pause", () => {
    let status = createInitialStatus(PIN);
    status = transitionOfflineModel(status, {
      type: "QUEUE_DOWNLOAD",
      userInitiated: true,
    });
    status = transitionOfflineModel(status, { type: "START" });
    status = transitionOfflineModel(status, {
      type: "PROGRESS",
      downloadedBytes: 42,
    });
    status = transitionOfflineModel(status, { type: "PAUSE" });
    expect(status.download).toBe("paused");
    status = transitionOfflineModel(status, { type: "RESUME" });
    expect(status.download).toBe("downloading");
    status = transitionOfflineModel(status, {
      type: "PROGRESS",
      downloadedBytes: 43,
    });
    status = transitionOfflineModel(status, { type: "CANCEL" });
    // Cancel keeps staged bytes for resume (archive modelTransfers rule);
    // only DELETE discards them.
    expect(status.download).toBe("paused");
    expect(status.downloadedBytes).toBe(43);
    status = transitionOfflineModel(status, { type: "DELETE" });
    expect(status.download).toBe("not-installed");
    expect(status.downloadedBytes).toBe(0);
  });

  it("rejects illegal transitions fail-closed", () => {
    const status = createInitialStatus(PIN);
    expect(() => transitionOfflineModel(status, { type: "LOAD" })).toThrow(
      /not installed/i,
    );
    expect(() => transitionOfflineModel(status, { type: "RESUME" })).toThrow();
  });

  it("loads and unloads residency only from installed", () => {
    const manager = installedManager();
    manager.dispatch(PIN.modelId, { type: "LOAD" });
    expect(manager.statusOf(PIN.modelId)?.residency).toBe("loading");
    manager.dispatch(PIN.modelId, { type: "LOADED" });
    expect(manager.statusOf(PIN.modelId)?.residency).toBe("resident");
    manager.dispatch(PIN.modelId, { type: "UNLOAD" });
    manager.dispatch(PIN.modelId, { type: "UNLOADED" });
    expect(manager.statusOf(PIN.modelId)?.residency).toBe("unloaded");
  });
});

describe("offline manager storage gate and recovery", () => {
  it("blocks the download gate on insufficient storage", async () => {
    const manager = new OfflineModelManager([PIN], {
      storageProbe: { freeBytes: async () => 1 },
    });
    const gate = await manager.checkDownloadGate(PIN.modelId, {
      userInitiated: true,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("INSUFFICIENT_STORAGE");
  });

  it("blocks the download gate without an explicit user confirmation", async () => {
    const manager = new OfflineModelManager([PIN], {
      storageProbe: { freeBytes: async () => PIN.downloadBytes * 2 },
    });
    const gate = await manager.checkDownloadGate(PIN.modelId, {
      userInitiated: false,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe("NOT_USER_INITIATED");
  });

  it("collapses transient states on snapshot restore (process-death recovery)", () => {
    const manager = new OfflineModelManager([PIN]);
    manager.dispatch(PIN.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    manager.dispatch(PIN.modelId, { type: "START" });
    manager.dispatch(PIN.modelId, { type: "PROGRESS", downloadedBytes: 77 });
    const snapshot = manager.snapshot();
    const revived = new OfflineModelManager([PIN]);
    revived.restore(snapshot);
    const status = revived.statusOf(PIN.modelId);
    // A download interrupted by process death is resumable, never lost
    // silently and never reported as installed.
    expect(status?.download).toBe("paused");
    expect(status?.downloadedBytes).toBe(77);
    expect(status?.residency).toBe("unloaded");
  });

  it("rejects snapshots from an unknown schema version", () => {
    const revived = new OfflineModelManager([PIN]);
    const bad = {
      version: 999,
      models: {},
    } as unknown as OfflineManagerSnapshot;
    expect(() => revived.restore(bad)).toThrow(/snapshot version/i);
  });

  it("round-trips installed state through a snapshot", () => {
    const manager = installedManager({ resident: true });
    const revived = new OfflineModelManager([PIN]);
    revived.restore(manager.snapshot());
    const status = revived.statusOf(PIN.modelId) as OfflineModelStatus;
    expect(status.download).toBe("installed");
    // Residency is runtime-only: a reload never claims a warm engine.
    expect(status.residency).toBe("unloaded");
    expect(status.checksumVerified).toBe(true);
  });

  it("exposes the snapshot version constant honestly", () => {
    expect(OFFLINE_MANAGER_SNAPSHOT_VERSION).toBe(1);
  });
});

describe("offline provider adapter", () => {
  function depsWith(
    manager: OfflineModelManager,
    bridge: OfflineNativeBridge,
  ): OfflineAdapterDeps {
    return { manager, bridge };
  }

  it("streams completion phases and deltas for a resident verified model", async () => {
    const bridge = controllableBridge(["Hello", " world"]);
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter(depsWith(manager, bridge));
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    const phases = events
      .filter((event) => event.kind === "phase")
      .map((event) => (event as { phase: string }).phase);
    expect(phases).toEqual([
      "queued",
      "sending",
      "first-token",
      "streaming",
      "complete",
    ]);
    const text = events
      .filter((event) => event.kind === "text")
      .map((event) => (event as { delta: string }).delta)
      .join("");
    expect(text).toBe("Hello world");
    const done = events.at(-1);
    expect(done?.kind).toBe("done");
    expect(bridge.generates).toBe(1);
  });

  it("loads an installed but unloaded model without downloading anything", async () => {
    const bridge = controllableBridge(["ok"]);
    const manager = installedManager();
    const adapter = createOfflineAdapter(depsWith(manager, bridge));
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(events.at(-1)?.kind).toBe("done");
    expect(bridge.loads).toEqual([PIN.modelId]);
    expect(manager.statusOf(PIN.modelId)?.residency).toBe("resident");
  });

  it("fails closed when the model is not installed and never touches the bridge", async () => {
    const bridge = controllableBridge(["must not stream"]);
    const manager = new OfflineModelManager([PIN]);
    const adapter = createOfflineAdapter(depsWith(manager, bridge));
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(errorOf(events).code).toBe("model_not_installed");
    expect(errorOf(events).retryable).toBe(false);
    expect(bridge.loads).toEqual([]);
    expect(bridge.generates).toBe(0);
  });

  it("fails closed on unverified checksum even when bytes are present", async () => {
    const bridge = controllableBridge(["must not stream"]);
    const manager = new OfflineModelManager([PIN]);
    manager.dispatch(PIN.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    manager.dispatch(PIN.modelId, { type: "START" });
    manager.dispatch(PIN.modelId, { type: "VERIFY_START" });
    manager.dispatch(PIN.modelId, { type: "VERIFY_FAIL", reason: "hash mismatch" });
    const adapter = createOfflineAdapter(depsWith(manager, bridge));
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(errorOf(events).code).toBe("model_not_installed");
    expect(bridge.generates).toBe(0);
  });

  it("fails closed on approved images (vision unproven on-device)", async () => {
    const bridge = controllableBridge(["must not stream"]);
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter(depsWith(manager, bridge));
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(errorOf(events).code).toBe("vision_unsupported");
    expect(bridge.generates).toBe(0);
  });

  it("fails closed when the native bridge is unavailable", async () => {
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter(depsWith(manager, FAILING_BRIDGE));
    const { request } = baseRequest();
    const events = await collect(adapter.complete(request));
    expect(errorOf(events).code).toBe("runtime_unavailable");
  });

  it("rejects selections for other providers", async () => {
    const bridge = controllableBridge(["must not stream"]);
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter(depsWith(manager, bridge));
    const { request } = baseRequest({
      selection: {
        accountId: "acct-1",
        provider: "openai",
        modelId: PIN.modelId,
        mode: "free-only",
      },
    });
    const events = await collect(adapter.complete(request));
    expect(errorOf(events).code).toBe("invalid_provider");
    expect(bridge.generates).toBe(0);
  });

  it("reports cancellation when already aborted", async () => {
    const bridge = controllableBridge(["must not stream"]);
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter(depsWith(manager, bridge));
    const { request, controller } = baseRequest();
    controller.abort();
    const events = await collect(adapter.complete(request));
    const done = events.at(-1);
    expect(done).toMatchObject({ kind: "done", stopReason: "cancelled" });
    expect(bridge.generates).toBe(0);
  });

  it("completes with no network access at all (fetch throws)", async () => {
    const bridge = controllableBridge(["offline ok"]);
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter(depsWith(manager, bridge));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network disabled"));
    try {
      const { request } = baseRequest();
      const events = await collect(adapter.complete(request));
      expect(events.at(-1)).toMatchObject({
        kind: "done",
        stopReason: "complete",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("lists only installed and verified models, priced as on-device free", async () => {
    const other: OfflineAssetPin = {
      ...PIN,
      modelId: "smolvlm2-500m-text",
      sha256: "b".repeat(64),
    };
    const manager = new OfflineModelManager([PIN, other]);
    manager.dispatch(PIN.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
    manager.dispatch(PIN.modelId, { type: "START" });
    manager.dispatch(PIN.modelId, { type: "VERIFY_START" });
    manager.dispatch(PIN.modelId, { type: "VERIFY_OK", actualSha256: PIN.sha256 });
    const adapter = createOfflineAdapter(
      depsWith(manager, controllableBridge([])),
    );
    const models = await adapter.listModels?.();
    expect(models?.map((model) => model.id)).toEqual([PIN.modelId]);
    expect(models?.[0]?.priceClass).toBe("free");
    expect(models?.[0]?.provider).toBe(OFFLINE_PROVIDER_ID);
  });

  it("advertises honest capabilities: streaming known, everything else unknown", () => {
    const adapter = createOfflineAdapter(
      depsWith(new OfflineModelManager([PIN]), controllableBridge([])),
    );
    expect(adapter.capabilities()).toEqual({
      vision: { state: "unknown" },
      maxImagesPerCall: { state: "unknown" },
      contextTokens: { state: "unknown" },
      maxOutputTokens: { state: "unknown" },
      streaming: { state: "known", value: true },
    });
  });
});

describe("offline vision path (native seam)", () => {
  function visionBridge(opts?: {
    available?: boolean;
    chunks?: string[];
    availableThrows?: boolean;
  }): OfflineVisionNativeBridge & {
    loads: { modelId: string; backend: string }[];
    describes: number;
    cancels: string[];
  } {
    const state = {
      loads: [] as { modelId: string; backend: string }[],
      describes: 0,
      cancels: [] as string[],
    };
    return {
      loads: state.loads,
      get describes() {
        return state.describes;
      },
      cancels: state.cancels,
      bridgeName: "test-vision-stub",
      isVisionAvailable: async () => {
        if (opts?.availableThrows === true) throw new Error("bridge down");
        return opts?.available ?? true;
      },
      loadVisionModel: async (args: { modelId: string; backend: "cpu" | "gpu" }) => {
        state.loads.push({ modelId: args.modelId, backend: args.backend });
      },
      unloadVisionModel: async () => {},
      describeImage: async function* () {
        state.describes += 1;
        for (const chunk of opts?.chunks ?? []) yield { textDelta: chunk };
      },
      cancelGeneration: async (generationId: string) => {
        state.cancels.push(generationId);
      },
    };
  }

  function visionDeps(
    manager: OfflineModelManager,
    bridge: OfflineNativeBridge,
    vision: OfflineVisionNativeBridge,
    opts?: {
      resolveVisionBackend?: () => "cpu" | "gpu";
      resolveApprovedImage?: (imageId: string) => Promise<string>;
    },
  ): OfflineAdapterDeps {
    return {
      manager,
      bridge,
      visionBridge: vision,
      resolveVisionBackend: opts?.resolveVisionBackend,
      resolveApprovedImage:
        opts?.resolveApprovedImage ?? (async () => "aW1hZ2UtYnl0ZXM="),
    };
  }

  it("streams vision deltas through the seam for one approved image", async () => {
    const textBridge = controllableBridge(["must not stream"]);
    const vision = visionBridge({ chunks: ["A red ", "umbrella"] });
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter(
      visionDeps(manager, textBridge, vision),
    );
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    const phases = events
      .filter((event) => event.kind === "phase")
      .map((event) => (event as { phase: string }).phase);
    expect(phases).toEqual([
      "queued",
      "sending",
      "first-token",
      "streaming",
      "complete",
    ]);
    const text = events
      .filter((event) => event.kind === "text")
      .map((event) => (event as { delta: string }).delta)
      .join("");
    expect(text).toBe("A red umbrella");
    expect(vision.loads).toEqual([{ modelId: PIN.modelId, backend: "cpu" }]);
    expect(vision.describes).toBe(1);
    expect(textBridge.generates).toBe(0);
  });

  it("fails closed without touching the seam when it reports unavailable", async () => {
    const textBridge = controllableBridge(["must not stream"]);
    const vision = visionBridge({ available: false, chunks: ["must not stream"] });
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter(
      visionDeps(manager, textBridge, vision),
    );
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(errorOf(events).code).toBe("vision_unsupported");
    expect(vision.describes).toBe(0);
    expect(vision.loads).toEqual([]);
  });

  it("surfaces a throwing availability probe as runtime_load_failed, never vision_unsupported", async () => {
    const textBridge = controllableBridge(["must not stream"]);
    const vision = visionBridge({ availableThrows: true });
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter(
      visionDeps(manager, textBridge, vision),
    );
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    const error = errorOf(events);
    expect(error.code).toBe("runtime_load_failed");
    // The real load error is carried through (truncated), not collapsed to "not proven".
    const errorEvent = events.find((event) => event.kind === "error") as Extract<StreamEvent, { kind: "error" }>;
    expect(errorEvent.message).toContain("bridge down");
    expect(vision.describes).toBe(0);
  });

  it("fails closed on multiple approved images", async () => {
    const textBridge = controllableBridge(["must not stream"]);
    const vision = visionBridge({ chunks: ["must not stream"] });
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter(
      visionDeps(manager, textBridge, vision),
    );
    const { request } = baseRequest({ approvedImageIds: ["a", "b"] });
    const events = await collect(adapter.complete(request));
    expect(errorOf(events).code).toBe("vision_unsupported");
    expect(vision.describes).toBe(0);
  });

  it("fails closed without an image resolver", async () => {
    const textBridge = controllableBridge(["must not stream"]);
    const vision = visionBridge({ chunks: ["must not stream"] });
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter({
      manager,
      bridge: textBridge,
      visionBridge: vision,
    });
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(errorOf(events).code).toBe("vision_unsupported");
    expect(vision.describes).toBe(0);
  });

  it("forwards the selector-resolved backend to the native load", async () => {
    const textBridge = controllableBridge(["must not stream"]);
    const vision = visionBridge({ chunks: ["ok"] });
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter(
      visionDeps(manager, textBridge, vision, {
        resolveVisionBackend: () => "gpu",
      }),
    );
    const { request } = baseRequest({ approvedImageIds: ["photo-1"] });
    const events = await collect(adapter.complete(request));
    expect(events.at(-1)).toMatchObject({ kind: "done", stopReason: "complete" });
    expect(vision.loads).toEqual([{ modelId: PIN.modelId, backend: "gpu" }]);
  });

  it("cancels an in-flight vision generation on abort", async () => {
    const textBridge = controllableBridge(["must not stream"]);
    const vision = visionBridge({ chunks: ["must not stream"] });
    const manager = installedManager({ resident: true });
    const adapter = createOfflineAdapter(
      visionDeps(manager, textBridge, vision),
    );
    const { request, controller } = baseRequest({ approvedImageIds: ["photo-1"] });
    controller.abort();
    const events = await collect(adapter.complete(request));
    expect(events.at(-1)).toMatchObject({ kind: "done", stopReason: "cancelled" });
    expect(vision.describes).toBe(0);
  });
});
