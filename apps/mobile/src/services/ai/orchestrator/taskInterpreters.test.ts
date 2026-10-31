/**
 * Task interpreter tests: exhaustive contracts, structured generation
 * modes, and role-driven selection.
 *
 * Every model-routable task id must have an interpreter (no implicit
 * success); roles decide which tasks a runtime may serve.
 */
import { describe, expect, it } from "vitest";
import { OfflineModelManager, type OfflineAssetPin } from "../offlineModelManager";
import { AiOrchestrator } from "./AiOrchestrator";
import { interpreterFor, listInterpreterTaskIds } from "./taskInterpreters";
import { TASK_IDS } from "./taskRegistry";
import { LOCAL_TASK_INVALID, validateRouteValue } from "./routeValidation";
import { registerProductionRuntimes, type ProductionRuntimeDeps } from "./productionRuntimes";
import { RuntimeRegistry } from "./runtimeRegistry";

const PIN: OfflineAssetPin = {
  modelId: "needle3-cact-l20",
  sha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38",
  downloadBytes: 35_335_380,
  minFreeRamMb: 512,
};

function install(manager: OfflineModelManager): void {
  manager.dispatch(PIN.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
  manager.dispatch(PIN.modelId, { type: "START" });
  manager.dispatch(PIN.modelId, { type: "PROGRESS", downloadedBytes: PIN.downloadBytes });
  manager.dispatch(PIN.modelId, { type: "VERIFY_START" });
  manager.dispatch(PIN.modelId, { type: "VERIFY_OK", actualSha256: PIN.sha256 });
}

describe("task interpreter totality", () => {
  it("covers every routable task id with no permissive fallthrough", () => {
    expect([...listInterpreterTaskIds()].sort()).toEqual([...TASK_IDS].sort());
    for (const taskId of TASK_IDS) {
      expect(interpreterFor(taskId)).toBeDefined();
    }
    expect(interpreterFor("no-such-task")).toBeUndefined();
  });

  it("fails closed on unknown task ids at the orchestrator layer", () => {
    const checked = validateRouteValue("no-such-task", { anything: true });
    expect(checked.ok).toBe(false);
  });
});

describe("structured task interpreters", () => {
  it("accepts a valid intent payload for classify-intent", () => {
    const interpreter = interpreterFor("classify-intent")!;
    expect(interpreter.generation).toBe("structured");
    const result = interpreter.interpret(JSON.stringify({ intent: "SEARCH" }), {
      taskId: "classify-intent",
      input: {},
    });
    expect(result.ok).toBe(true);
  });

  it("rejects garbage for classify-intent", () => {
    const interpreter = interpreterFor("classify-intent")!;
    const result = interpreter.interpret("not json at all", { taskId: "classify-intent", input: {} });
    expect(result.ok).toBe(false);
  });

  it("refuses OPEN_MAP without caller-confirmed location", () => {
    const interpreter = interpreterFor("route-intent")!;
    const blocked = interpreter.interpret(JSON.stringify({ route: "OPEN_MAP" }), {
      taskId: "route-intent",
      input: { intent: "SEARCH" },
    });
    expect(blocked.ok).toBe(false);
    const allowed = interpreter.interpret(
      JSON.stringify({ route: "OPEN_MAP", reason: "nearby shelf" }),
      { taskId: "route-intent", input: { intent: "SEARCH", hasLocation: true } },
    );
    expect(allowed.ok).toBe(true);
  });
});

describe("role-driven selection", () => {
  function depsWithRoles(taskRoles: readonly string[]): ProductionRuntimeDeps {
    const manager = new OfflineModelManager([PIN]);
    install(manager);
    return {
      manager,
      text: {
        modelId: PIN.modelId,
        runtimeId: "needle-cact",
        taskRoles,
        isReady: async () => true,
        completeStructured: async () => JSON.stringify({ fields: { title: "wallet" } }),
      },
    };
  }

  it("refuses a task the installed runtime is not permitted to serve", async () => {
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, depsWithRoles(["extract-report-fields"]));
    const orchestrator = new AiOrchestrator();
    const result = await orchestrator.route(
      "extract-search-filters",
      { prompt: "black wallet lost last week" },
      { traceId: "trace-role-refused", registry },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denialReason).toBe("NO_RUNTIME");
  });

  it("fails closed when the generation mode does not match the task", async () => {
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, depsWithRoles(["embed-texts"]));
    const outcome = await registry.get("local-text")?.invoke({
      taskId: "embed-texts",
      input: { texts: ["red umbrella"] },
      timeoutMs: 1000,
      traceId: "trace-mode-mismatch",
      signal: new AbortController().signal,
    });
    expect(outcome?.ok).toBe(false);
    if (outcome !== undefined && !outcome.ok) {
      expect(outcome.denialReason).toBe("NO_TASK_CONTRACT");
    }
  });

  it("keeps LOCAL_TASK_INVALID as the contract-failure reason end to end", async () => {
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, depsWithRoles(["extract-search-filters"]));
    const orchestrator = new AiOrchestrator();
    const result = await orchestrator.route(
      "extract-search-filters",
      { prompt: "title: red umbrella" },
      { traceId: "trace-contract-e2e", registry },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denialReason).toBe(LOCAL_TASK_INVALID);
  });
});
