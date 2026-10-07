/**
 * Task interpreter tests: exhaustive contracts, raw/structured generation
 * modes, and role-driven selection.
 *
 * Every model-routable task id must have an interpreter (no implicit
 * success); prose tasks validate free text without JSON; roles decide
 * which tasks a runtime may serve.
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

describe("prose task interpreters", () => {
  it("accepts validated free prose for answer-help (never JSON)", () => {
    const interpreter = interpreterFor("answer-help")!;
    expect(interpreter.generation).toBe("raw");
    const result = interpreter.interpret("Open the Report tab, choose Lost, then fill in the item details.", {
      taskId: "answer-help",
      input: {},
    });
    expect(result).toEqual({
      ok: true,
      value: { answerText: "Open the Report tab, choose Lost, then fill in the item details." },
    });
  });

  it("screens unsafe prose into the grounded reply instead of succeeding raw", () => {
    const interpreter = interpreterFor("answer-help")!;
    const result = interpreter.interpret("SELECT * FROM users WHERE id = 1", {
      taskId: "answer-help",
      input: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { answerText: string };
      expect(value.answerText).not.toContain("SELECT");
    }
  });

  it("rejects empty and overlong help prose", () => {
    const interpreter = interpreterFor("answer-help")!;
    expect(interpreter.interpret("   ", { taskId: "answer-help", input: {} }).ok).toBe(false);
    expect(interpreter.interpret("x".repeat(2001), { taskId: "answer-help", input: {} }).ok).toBe(false);
  });

  it("rejects summaries that leak coordinates", () => {
    const interpreter = interpreterFor("summarize-local-context")!;
    expect(interpreter.generation).toBe("raw");
    const leaked = interpreter.interpret("Two reports near 23.8103, 90.4125 downtown.", {
      taskId: "summarize-local-context",
      input: {},
    });
    expect(leaked.ok).toBe(false);
    const clean = interpreter.interpret("Two reports filed downtown this week.", {
      taskId: "summarize-local-context",
      input: {},
    });
    expect(clean).toEqual({ ok: true, value: { summary: "Two reports filed downtown this week." } });
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
        completeText: async (input: string) => input,
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

  it("routes free prose through raw generation for answer-help", async () => {
    const manager = new OfflineModelManager([PIN]);
    install(manager);
    let structuredCalls = 0;
    const registry = new RuntimeRegistry();
    registerProductionRuntimes(registry, {
      manager,
      text: {
        modelId: PIN.modelId,
        runtimeId: "needle-cact",
        taskRoles: ["answer-help"],
        isReady: async () => true,
        completeText: async () => "Open the Report tab, choose Lost, then fill in the item details.",
        completeStructured: async () => {
          structuredCalls += 1;
          throw new Error("structured mode must not run for prose tasks");
        },
      },
    });
    const orchestrator = new AiOrchestrator();
    const result = await orchestrator.route(
      "answer-help",
      { prompt: "where do i file a lost item report" },
      { traceId: "trace-raw-prose", registry },
    );
    expect(structuredCalls).toBe(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        answerText: "Open the Report tab, choose Lost, then fill in the item details.",
      });
    }
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
