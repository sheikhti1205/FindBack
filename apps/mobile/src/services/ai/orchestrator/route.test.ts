import { describe, expect, it, vi } from "vitest";
import { AiOrchestrator } from "./AiOrchestrator";
import { RuntimeRegistry, type AiRuntime, type RuntimeInvokeInput, type RuntimeResult } from "./runtimeRegistry";
import type { OrchestratorState } from "./provenance";

type InvokeMock = ReturnType<typeof vi.fn<(input: RuntimeInvokeInput) => Promise<RuntimeResult>>>;

function modelRuntime(
  id: string,
  value: unknown,
  invoke?: InvokeMock,
): { runtime: AiRuntime; invoke: InvokeMock } {
  const spy: InvokeMock =
    invoke ??
    vi.fn(async (): Promise<RuntimeResult> => ({ ok: true, value, modelId: id, backend: id, runtimeId: id }));
  return {
    invoke: spy,
    runtime: { id, kind: "model", available: () => true, invoke: spy },
  };
}

describe("AiOrchestrator.route", () => {
  it("prefers the deterministic path and never invokes a model when resolved", async () => {
    const first = modelRuntime("local-text", { intent: "REPORT_LOST" });
    const second = modelRuntime("remote-text", { intent: "REPORT_LOST" });
    const registry = new RuntimeRegistry();
    registry.register(first.runtime);
    registry.register(second.runtime);
    const orchestrator = new AiOrchestrator();
    const seen: OrchestratorState[] = [];
    const result = await orchestrator.route("classify-intent", { text: "I lost my wallet" }, {
      traceId: "trace-route-deterministic-001",
      registry,
      onState: (state) => {
        seen.push(state);
      },
    });
    expect(result.ok).toBe(true);
    expect(first.invoke).not.toHaveBeenCalled();
    expect(second.invoke).not.toHaveBeenCalled();
    expect(result.provenance.actualBackend).toBe("deterministic-local");
    expect(result.provenance.taskId).toBe("classify-intent");
    expect(result.provenance.traceId).toBe("trace-route-deterministic-001");
    expect(seen).toEqual(["RESOLVING", "COMPLETE"]);
    expect(orchestrator.routeState).toBe("COMPLETE");
  });

  it("invokes exactly one runtime on the model path", async () => {
    const first = modelRuntime("local-text", { fields: { title: "red umbrella" } });
    const second = modelRuntime("remote-text", { fields: { title: "other umbrella" } });
    const registry = new RuntimeRegistry();
    registry.register(first.runtime);
    registry.register(second.runtime);
    const orchestrator = new AiOrchestrator();
    const seen: OrchestratorState[] = [];
    const result = await orchestrator.route(
      "extract-report-fields",
      { text: "xqzzy incomprehensible wobble query 42" },
      {
        traceId: "trace-route-single-001",
        registry,
        onState: (state) => {
          seen.push(state);
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(first.invoke).toHaveBeenCalledTimes(1);
    expect(second.invoke).not.toHaveBeenCalled();
    expect(result.provenance.actualBackend).toBe("local-text");
    expect(seen).toEqual(["RESOLVING", "INVOKING", "COMPLETE"]);
  });

  it("denies a destructive model proposal and records the denial", async () => {
    // Retained tools accept only their narrow data contracts: an action
    // proposal is rejected before it can reach the independent action gate.
    const evil = modelRuntime("local-text", {
      fields: { title: "red umbrella" },
      op: "publish_report",
      args: { reportId: "r-1" },
    });
    const registry = new RuntimeRegistry();
    registry.register(evil.runtime);
    const orchestrator = new AiOrchestrator();
    const result = await orchestrator.route(
      "extract-report-fields",
      { text: "xqzzy incomprehensible wobble query 42" },
      {
        traceId: "trace-route-destructive-001",
        registry,
        permissions: { accountId: "user-123", canProposeComments: true },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denialReason).toBe("LOCAL_TASK_INVALID");
      expect(result.provenance.denialReason).toBe("LOCAL_TASK_INVALID");
      expect(result.state).toBe("FAILED");
    }
    expect(orchestrator.routeState).toBe("FAILED");
  });

  it("always populates the full provenance record", async () => {
    const runtime = modelRuntime("local-text", { fields: { title: "red umbrella" } });
    const registry = new RuntimeRegistry();
    registry.register(runtime.runtime);
    const orchestrator = new AiOrchestrator();
    const result = await orchestrator.route(
      "extract-report-fields",
      { text: "xqzzy incomprehensible wobble query 42" },
      { traceId: "trace-route-prov-001", registry, modelId: "model-under-test" },
    );
    const provenance = result.provenance;
    expect(result.ok).toBe(true);
    expect(provenance.taskId).toBe("extract-report-fields");
    expect(provenance.modelId).toBe("model-under-test");
    expect(typeof provenance.requestedBackend).toBe("string");
    expect(typeof provenance.actualBackend).toBe("string");
    expect(typeof provenance.latencyMs).toBe("number");
    expect(provenance.traceId).toBe("trace-route-prov-001");
    expect(Number.isFinite(provenance.latencyMs)).toBe(true);
  });

  it("fails closed on an unknown task", async () => {
    const orchestrator = new AiOrchestrator();
    const result = await orchestrator.route("teleport", { text: "beam me up" }, {
      traceId: "trace-route-unknown-001",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denialReason).toBe("UNKNOWN_TASK");
      expect(result.provenance.denialReason).toBe("UNKNOWN_TASK");
      expect(result.state).toBe("FAILED");
      expect(result.provenance.traceId).toBe("trace-route-unknown-001");
    }
  });

  it("fails closed without fabricated tool output when the model runtime fails", async () => {
    const failing: AiRuntime = {
      id: "local-text",
      kind: "model",
      available: () => true,
      invoke: async () => ({ ok: false, error: "boom", denialReason: "RUNTIME_ERROR" }),
    };
    const registry = new RuntimeRegistry();
    registry.register(failing);
    const orchestrator = new AiOrchestrator();
    const result = await orchestrator.route(
      "extract-report-fields",
      { text: "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima" },
      { traceId: "trace-route-fallback-001", registry },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denialReason).toBe("RUNTIME_ERROR");
      expect(result.fallback).toBeUndefined();
    }
  });
});

describe("AiOrchestrator.route image budget", () => {
  function visionRegistry(value: unknown = { text: "described" }) {
    const vision = modelRuntime("local-vision", value);
    const registry = new RuntimeRegistry();
    registry.register(vision.runtime);
    return { registry, vision };
  }

  it.each(["analyze-image", "ground-objects", "answer-help", "summarize-local-context"])("refuses retired task %s even if a runtime is injected", async (taskId) => {
    const { registry, vision } = visionRegistry();
    const orchestrator = new AiOrchestrator();
    const result = await orchestrator.route(
      taskId,
      { prompt: "describe", imageBase64: "A".repeat(200_000) },
      { traceId: "trace-image-budget-001", registry },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denialReason).toBe("UNKNOWN_TASK");
    expect(vision.invoke).not.toHaveBeenCalled();
  });

  it.each([{ imageBase64: "aGVsbG8=" }, { images: ["aGVsbG8="] }])("refuses images on retained text-only tasks before invoking a runtime: %j", async (image) => {
    const text = modelRuntime("local-text", { fields: { title: "umbrella" } });
    const registry = new RuntimeRegistry();
    registry.register(text.runtime);
    const orchestrator = new AiOrchestrator();
    const result = await orchestrator.route(
      "extract-report-fields",
      { prompt: "describe", ...image },
      { traceId: "trace-image-budget-002", registry },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denialReason).toBe("INPUT_BOUNDS");
    expect(text.invoke).not.toHaveBeenCalled();
  });
});
