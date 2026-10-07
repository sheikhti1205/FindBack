/**
 * Phase A coherence red tests (STEP 1).
 *
 * Each test asserts the Phase A target contract against the REAL production
 * seams (AiOrchestrator + registerProductionRuntimes + real task specs +
 * real search normalization). Tests that fail on baseline main prove the
 * architectural defects; the paired Step 2-7 fixes make them pass without
 * changing the assertions.
 *
 * Baseline: main 1bc93d68d8527a5c7929c4e8201102a5c48050d4.
 */
import { describe, expect, it } from "vitest";
import { OfflineModelManager, type OfflineAssetPin } from "../offlineModelManager";
import { profileFor } from "../modelProfiles";
import { normalizeJsonOp, validateSearchFilters } from "../normalize";
import { AiOrchestrator } from "./AiOrchestrator";
import { registerProductionRuntimes, type ProductionRuntimeDeps } from "./productionRuntimes";
import { RuntimeRegistry } from "./runtimeRegistry";

const NEEDLE_PIN: OfflineAssetPin = {
  modelId: "needle3-cact-l20",
  sha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38",
  downloadBytes: 35_335_380,
  minFreeRamMb: 512,
};

function install(manager: OfflineModelManager, pin: OfflineAssetPin): void {
  manager.dispatch(pin.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
  manager.dispatch(pin.modelId, { type: "START" });
  manager.dispatch(pin.modelId, { type: "PROGRESS", downloadedBytes: pin.downloadBytes });
  manager.dispatch(pin.modelId, { type: "VERIFY_START" });
  manager.dispatch(pin.modelId, { type: "VERIFY_OK", actualSha256: pin.sha256 });
}

/**
 * Mirror of the production text seam: the structured mode always runs the
 * `record_item` report tool and returns report slots nested under `fields`,
 * whatever the task was. Raw mode echoes free text.
 */
function needleReportShapedBackend() {
  return {
    modelId: NEEDLE_PIN.modelId,
    runtimeId: "needle-cact",
    taskRoles: ["extract-report-fields", "extract-search-filters", "classify-category"],
    isReady: async () => true,
    completeText: async (input: string) => input,
    completeStructured: async () =>
      JSON.stringify({ fields: { title: "red umbrella", description: "found downtown" } }),
  };
}

function depsWithNeedleText(manager: OfflineModelManager): ProductionRuntimeDeps {
  return { manager, text: needleReportShapedBackend() };
}

function installedNeedle(): { manager: OfflineModelManager; deps: ProductionRuntimeDeps } {
  const manager = new OfflineModelManager([NEEDLE_PIN]);
  install(manager, NEEDLE_PIN);
  return { manager, deps: depsWithNeedleText(manager) };
}

describe("Phase A: task validity owns route success", () => {
  it("a report-shaped local-text value is NOT a successful extract-search-filters route", async () => {
    const { manager, deps } = installedNeedle();
    const orchestrator = new AiOrchestrator();
    orchestrator.attachProductionRuntimes(deps);
    void manager;
    const result = await orchestrator.route(
      "extract-search-filters",
      { prompt: "black wallet lost last week near central market" },
      { traceId: "phase-a-shape", consent: true },
    );
    // Target contract (Step 5): SUCCESS requires a task-valid output.
    // Report-shaped {fields} can never satisfy search-filters/v1, so the
    // route must fail task-invalid (Automatic-eligible) instead of ok:true.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denialReason).toBe("LOCAL_TASK_INVALID");
  });

  it("the same report-shaped value REMAINS a successful extract-report-fields route", async () => {
    const { deps } = installedNeedle();
    const orchestrator = new AiOrchestrator();
    orchestrator.attachProductionRuntimes(deps);
    const result = await orchestrator.route(
      "extract-report-fields",
      { prompt: "title: red umbrella\ndescription: found downtown" },
      { traceId: "phase-a-shape-guard", consent: true },
    );
    // Guard: fixing the search shape must not break the report shape, which
    // genuinely matches report-slots/v1.
    expect(result.ok).toBe(true);
  });

  it("Needle-shaped output provably fails the real search normalization (Help-workaround pair)", () => {
    const profile = profileFor("qwen3-0.6b-dynamic-int4")!;
    const needleOutput = JSON.stringify({ fields: { title: "red umbrella" } });
    const parsed = normalizeJsonOp(needleOutput, profile, (value, ctx) =>
      validateSearchFilters(value, ctx),
    );
    // Documents the parser side of the mismatch: strictKeys rejects the
    // `fields` wrapper, so no Needle-shaped value can ever become filters.
    // Help.tsx unwraps this ad hoc; the Step 5 boundary must make that
    // workaround unnecessary instead of copying it elsewhere.
    expect(parsed.ok).toBe(false);
  });
});

describe("Phase A: provenance names the actual runtime", () => {
  it("a local-text route result identifies the real runtime backend, not just the task id", async () => {
    const { deps } = installedNeedle();
    const orchestrator = new AiOrchestrator();
    orchestrator.attachProductionRuntimes(deps);
    const result = await orchestrator.route(
      "extract-report-fields",
      { prompt: "title: keys\ndescription: lost at park" },
      { traceId: "phase-a-provenance", consent: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Target contract (Step 6): provenance must carry the actual runtime
      // id so downstream normalization is driven by the producer (Needle),
      // never by a hard-coded Qwen profile for Needle output.
      const provenance = result.provenance as unknown as Record<string, unknown>;
      expect(provenance["runtimeId"]).toBe("needle-cact");
      expect(result.provenance.modelId).toBe(NEEDLE_PIN.modelId);
    }
  });
});

describe("Phase A: route timeout cancels the underlying work", () => {
  it("a timed-out route aborts the runtime signal; native work must not outlive TIMEOUT", async () => {
    const manager = new OfflineModelManager([NEEDLE_PIN]);
    install(manager, NEEDLE_PIN);
    let observedSignal: AbortSignal | undefined;
    let settled = false;
    const deps: ProductionRuntimeDeps = {
      manager,
      text: {
        modelId: NEEDLE_PIN.modelId,
        runtimeId: "needle-cact",
        taskRoles: ["extract-report-fields", "extract-search-filters", "classify-category"],
        isReady: async () => true,
        // Never settles on its own; only the abort signal may release it.
        completeText: (input: string) =>
          new Promise<string>((resolve, reject) => {
            void input;
            observedSignal?.addEventListener("abort", () => {
              settled = true;
              reject(new Error("cancelled"));
            });
          }),
        completeStructured: () =>
          new Promise<string>((_resolve, reject) => {
            observedSignal?.addEventListener("abort", () => {
              settled = true;
              reject(new Error("cancelled"));
            });
          }),
      },
    };
    // Capture the signal the runtime actually receives by wrapping invoke
    // input: the registry adapter builds the invoke payload, so observe it
    // through a proxy runtime registered under the same id.
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, deps);
    const runtime = registry.get("local-text")!;
    const original = runtime.invoke.bind(runtime);
    (runtime as { invoke: typeof original }).invoke = (input) => {
      observedSignal = (input as unknown as Record<string, unknown>)["signal"] as AbortSignal | undefined;
      return original(input);
    };
    const orchestrator = new AiOrchestrator();
    orchestrator.attachProductionRuntimes(deps);
    // Swap the shared registry entry so the route hits the observed runtime.
    const shared = (orchestrator as unknown as { sharedRegistry: RuntimeRegistry }).sharedRegistry;
    shared.register(runtime);
    const result = await orchestrator.route(
      "extract-search-filters",
      { prompt: "something no deterministic rule can resolve !@# qzx" },
      { traceId: "phase-a-cancel", consent: true, timeoutMs: 1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denialReason).toBe("TIMEOUT");
    // Target contract (Step 7): the runtime received a signal and it is
    // aborted once TIMEOUT is returned — no orphan native generation.
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal!.aborted).toBe(true);
    expect(settled).toBe(true);
  });
});
