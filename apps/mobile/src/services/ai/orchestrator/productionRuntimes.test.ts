/**
 * Production runtime registration tests (WS-G).
 *
 * The task specs name `local-text`, `local-embedding`, and `local-vision`
 * runtimes, but the default registry only carries `deterministic-local`:
 * without production adapters every non-deterministic route ends in
 * NO_RUNTIME. These tests pin the production layer — manager-driven
 * availability (installed + checksum-verified + seam present), invoke-time
 * liveness re-probes, and provenance carrying the real profile id,
 * backend, and revision — using hand-built fake seams. No network, no
 * model binaries, no native bridge.
 */
import { describe, expect, it } from "vitest";
import { OfflineModelManager, type OfflineAssetPin } from "../offlineModelManager";
import { AiOrchestrator } from "./AiOrchestrator";
import {
  LOCAL_EMBEDDING_RUNTIME_ID,
  LOCAL_TEXT_RUNTIME_ID,
  LOCAL_VISION_RUNTIME_ID,
  PRODUCTION_RUNTIME_IDS,
  registerProductionRuntimes,
  type ProductionRuntimeDeps,
} from "./productionRuntimes";
import { RuntimeRegistry } from "./runtimeRegistry";

const TEXT_PIN: OfflineAssetPin = {
  modelId: "qwen3-0.6b-dynamic-int4",
  sha256: "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
  downloadBytes: 600_000_000,
  minFreeRamMb: 1500,
};

const EMBEDDING_PIN: OfflineAssetPin = {
  modelId: "needle3-cact-l20",
  sha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38",
  downloadBytes: 35_335_380,
  minFreeRamMb: 512,
};

const VISION_PIN: OfflineAssetPin = {
  modelId: "smolvlm2-500M-vision",
  sha256: "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0",
  downloadBytes: 360_822_960,
  minFreeRamMb: 1500,
};

function install(manager: OfflineModelManager, pin: OfflineAssetPin): void {
  manager.dispatch(pin.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
  manager.dispatch(pin.modelId, { type: "START" });
  manager.dispatch(pin.modelId, { type: "PROGRESS", downloadedBytes: pin.downloadBytes });
  manager.dispatch(pin.modelId, { type: "VERIFY_START" });
  manager.dispatch(pin.modelId, { type: "VERIFY_OK", actualSha256: pin.sha256 });
}

const TEXT_ROLES = [
  "extract-report-fields",
  "extract-search-filters",
  "classify-category",
  "classify-intent",
  "route-intent",
  "answer-help",
  "summarize-local-context",
];

function depsWithFakes(manager: OfflineModelManager): ProductionRuntimeDeps {
  return {
    manager,
    text: {
      modelId: TEXT_PIN.modelId,
      runtimeId: "test-text",
      taskRoles: TEXT_ROLES,
      isReady: async () => true,
      completeText: async (input: string) => input,
      completeStructured: async (input: string) => JSON.stringify({ echo: input.slice(0, 8) }),
    },
    embedding: {
      modelId: EMBEDDING_PIN.modelId,
      runtimeId: "test-embedding",
      taskRoles: ["embed-texts"],
      dimension: 4,
      isReady: async () => true,
      embed: async (texts: string[]) => texts.map(() => [0.5, -0.25, 0.125, -0.0625]),
    },
    vision: {
      modelId: VISION_PIN.modelId,
      runtimeId: "test-vision",
      taskRoles: ["analyze-image", "ground-objects"],
      isAvailable: async () => true,
      describe: async (prompt: string) => `saw: ${prompt}`,
    },
  };
}

function installedDeps(): ProductionRuntimeDeps {
  const manager = new OfflineModelManager([TEXT_PIN, EMBEDDING_PIN, VISION_PIN]);
  install(manager, TEXT_PIN);
  install(manager, EMBEDDING_PIN);
  install(manager, VISION_PIN);
  return depsWithFakes(manager);
}

describe("registerProductionRuntimes", () => {
  it("registers the local-text, local-embedding, and local-vision runtime ids", () => {
    const registry = new RuntimeRegistry();
    const registered = registerProductionRuntimes(registry, installedDeps());
    expect([...registered].sort()).toEqual([...PRODUCTION_RUNTIME_IDS].sort());
    expect(registry.get(LOCAL_TEXT_RUNTIME_ID)).toBeDefined();
    expect(registry.get(LOCAL_EMBEDDING_RUNTIME_ID)).toBeDefined();
    expect(registry.get(LOCAL_VISION_RUNTIME_ID)).toBeDefined();
  });

  it("registers only the runtimes whose backend seam is provided", () => {
    const manager = new OfflineModelManager([TEXT_PIN]);
    install(manager, TEXT_PIN);
    const registry = new RuntimeRegistry();
    const { text, ..._rest } = depsWithFakes(manager);
    void _rest;
    registerProductionRuntimes(registry, { manager, text });
    expect(registry.get(LOCAL_TEXT_RUNTIME_ID)).toBeDefined();
    expect(registry.get(LOCAL_EMBEDDING_RUNTIME_ID)).toBeUndefined();
    expect(registry.get(LOCAL_VISION_RUNTIME_ID)).toBeUndefined();
  });

  it("never registers the lab-only llama.cpp challenger as a routable runtime", () => {
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, installedDeps());
    for (const runtime of registry.list()) {
      expect(runtime.id).not.toMatch(/llama|lab/i);
    }
    expect(registry.get("llama-cpp")).toBeUndefined();
  });

  it("reports unavailable while the model is not installed and verified", () => {
    const manager = new OfflineModelManager([TEXT_PIN, EMBEDDING_PIN, VISION_PIN]);
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, depsWithFakes(manager));
    expect(registry.get(LOCAL_TEXT_RUNTIME_ID)?.available()).toBe(false);
    expect(registry.get(LOCAL_EMBEDDING_RUNTIME_ID)?.available()).toBe(false);
    expect(registry.get(LOCAL_VISION_RUNTIME_ID)?.available()).toBe(false);
  });

  it("reports available once installed, verified, and the seam is present", () => {
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, installedDeps());
    expect(registry.get(LOCAL_TEXT_RUNTIME_ID)?.available()).toBe(true);
    expect(registry.get(LOCAL_EMBEDDING_RUNTIME_ID)?.available()).toBe(true);
    expect(registry.get(LOCAL_VISION_RUNTIME_ID)?.available()).toBe(true);
  });

  it("advertises structured roles only while the structured engine is installed", () => {
    const manager = new OfflineModelManager([TEXT_PIN, EMBEDDING_PIN]);
    install(manager, TEXT_PIN);
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, {
      manager,
      text: {
        modelId: TEXT_PIN.modelId,
        modelIds: [TEXT_PIN.modelId, EMBEDDING_PIN.modelId],
        runtimeId: "test-text",
        taskRoles: TEXT_ROLES,
        structuredModelId: EMBEDDING_PIN.modelId,
        isReady: async () => true,
        completeText: async (input: string) => input,
        completeStructured: async () => "{}",
      },
    });
    const runtime = registry.get(LOCAL_TEXT_RUNTIME_ID);
    // Prose install alone: chat is served, structured extraction is not.
    expect(runtime?.available()).toBe(true);
    expect(runtime?.servesTask?.("answer-help")).toBe(true);
    expect(runtime?.servesTask?.("extract-report-fields")).toBe(false);
    // Installing the structured engine opens the structured role.
    install(manager, EMBEDDING_PIN);
    expect(runtime?.servesTask?.("extract-report-fields")).toBe(true);
  });

  it("fails closed with MODEL_NOT_READY when the resident dies between availability and invoke", async () => {
    let live = true;
    const manager = new OfflineModelManager([TEXT_PIN]);
    install(manager, TEXT_PIN);
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, {
      manager,
      text: {
        modelId: TEXT_PIN.modelId,
        runtimeId: "test-text",
        taskRoles: TEXT_ROLES,
        isReady: async () => live,
        completeText: async () => "{}",
        completeStructured: async () => "{}",
      },
    });
    const runtime = registry.get(LOCAL_TEXT_RUNTIME_ID);
    expect(runtime?.available()).toBe(true);
    live = false;
    const outcome = await runtime?.invoke({
      taskId: "extract-report-fields",
      input: "a wallet found downtown",
      timeoutMs: 1000,
      traceId: "trace-dead-resident",
      signal: new AbortController().signal,
    });
    expect(outcome?.ok).toBe(false);
    if (outcome !== undefined && !outcome.ok) {
      expect(outcome.denialReason).toBe("MODEL_NOT_READY");
    }
  });

  it("rejects non-JSON model output as task-invalid instead of guessing", async () => {
    const manager = new OfflineModelManager([TEXT_PIN]);
    install(manager, TEXT_PIN);
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, {
      manager,
      text: {
        modelId: TEXT_PIN.modelId,
        runtimeId: "test-text",
        taskRoles: TEXT_ROLES,
        isReady: async () => true,
        completeText: async () => "not json at all",
        completeStructured: async () => "not json at all",
      },
    });
    const outcome = await registry.get(LOCAL_TEXT_RUNTIME_ID)?.invoke({
      taskId: "extract-report-fields",
      input: "a wallet found downtown",
      timeoutMs: 1000,
      traceId: "trace-bad-json",
      signal: new AbortController().signal,
    });
    expect(outcome?.ok).toBe(false);
    if (outcome !== undefined && !outcome.ok) {
      // Contract failure (not a transport error): Automatic-eligible, never
      // a guessed value.
      expect(outcome.denialReason).toBe("LOCAL_TASK_INVALID");
    }
  });

  it("validates embedding vectors against the probed dimension", async () => {
    const manager = new OfflineModelManager([EMBEDDING_PIN]);
    install(manager, EMBEDDING_PIN);
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, {
      manager,
      embedding: {
        modelId: EMBEDDING_PIN.modelId,
        runtimeId: "test-embedding",
        taskRoles: ["embed-texts"],
        dimension: 4,
        isReady: async () => true,
        embed: async () => [[0.1, 0.2]],
      },
    });
    const outcome = await registry.get(LOCAL_EMBEDDING_RUNTIME_ID)?.invoke({
      taskId: "embed-texts",
      input: { texts: ["red umbrella"] },
      timeoutMs: 1000,
      traceId: "trace-bad-vectors",
      signal: new AbortController().signal,
    });
    expect(outcome?.ok).toBe(false);
    if (outcome !== undefined && !outcome.ok) {
      expect(outcome.denialReason).toBe("INVALID_OUTPUT");
    }
  });

  it("routes a non-deterministic text task through local-text with real provenance", async () => {
    const manager = new OfflineModelManager([TEXT_PIN]);
    install(manager, TEXT_PIN);
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, {
      manager,
      text: {
        modelId: TEXT_PIN.modelId,
        runtimeId: "test-text",
        taskRoles: TEXT_ROLES,
        isReady: async () => true,
        completeText: async () => "{}",
        completeStructured: async () => JSON.stringify({ fields: { title: "wallet" } }),
      },
    });
    const orchestrator = new AiOrchestrator();
    // No "title:"/"category:" markers, so no deterministic rule resolves and
    // the model path runs.
    const result = await orchestrator.route("extract-report-fields", "a wallet found downtown", {
      traceId: "trace-prod-text",
      registry,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.actualBackend).toBe(LOCAL_TEXT_RUNTIME_ID);
      expect(result.provenance.runtimeId).toBe("test-text");
      expect(result.provenance.requestedBackend).toBe("deterministic-local");
      expect(result.provenance.modelId).toBe(TEXT_PIN.modelId);
      expect(result.provenance.modelRevision).toBe(
        "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76",
      );
    }
  });

  it("routes embed-texts through local-embedding with the pinned needle model id", async () => {
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, installedDeps());
    const orchestrator = new AiOrchestrator();
    const result = await orchestrator.route(
      "embed-texts",
      { texts: ["red umbrella"] },
      { traceId: "trace-prod-embed", registry },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.actualBackend).toBe(LOCAL_EMBEDDING_RUNTIME_ID);
      expect(result.provenance.modelId).toBe(EMBEDDING_PIN.modelId);
      expect(result.value).toEqual({ vectors: [[0.5, -0.25, 0.125, -0.0625]] });
    }
  });

  it("routes analyze-image through local-vision", async () => {
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, installedDeps());
    const orchestrator = new AiOrchestrator();
    const result = await orchestrator.route(
      "analyze-image",
      { prompt: "describe", imageBase64: "aGVsbG8=" },
      { traceId: "trace-prod-vision", registry },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.actualBackend).toBe(LOCAL_VISION_RUNTIME_ID);
      expect(result.provenance.modelId).toBe(VISION_PIN.modelId);
      expect(result.value).toEqual({ text: "saw: describe" });
    }
  });
});
