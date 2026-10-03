import { describe, expect, it, vi } from "vitest";
import { RuntimeRegistry, type AiRuntime } from "./runtimeRegistry";

function stubRuntime(
  id: string,
  overrides: Partial<Pick<AiRuntime, "available" | "invoke">> = {},
): AiRuntime {
  return {
    id,
    kind: "model",
    available: overrides.available ?? (() => true),
    invoke:
      overrides.invoke ??
      (async () => ({ ok: true as const, value: { echo: id }, modelId: id, backend: id })),
  };
}

describe("runtimeRegistry", () => {
  it("registers and resolves runtimes by id", () => {
    const registry = new RuntimeRegistry();
    expect(registry.get("local-text")).toBeUndefined();
    registry.register(stubRuntime("local-text"));
    expect(registry.get("local-text")?.id).toBe("local-text");
    expect(registry.list().map((runtime: AiRuntime) => runtime.id)).toEqual(["local-text"]);
  });

  it("picks the first available runtime in spec order (single path)", () => {
    const registry = new RuntimeRegistry();
    registry.register(stubRuntime("offline-a", { available: () => false }));
    registry.register(stubRuntime("offline-b"));
    expect(registry.firstAvailable(["missing", "offline-a", "offline-b"])?.id).toBe("offline-b");
    expect(registry.firstAvailable(["missing", "offline-a"])).toBeUndefined();
  });

  it("invokes exactly once per call and surfaces the backend", async () => {
    const invoke = vi.fn(async () => ({
      ok: true as const,
      value: { text: "hi" },
      modelId: "local-text",
      backend: "local-text",
    }));
    const registry = new RuntimeRegistry();
    registry.register(stubRuntime("local-text", { invoke }));
    const runtime = registry.get("local-text");
    expect(runtime?.available()).toBe(true);
    const result = await runtime?.invoke({
      taskId: "answer-help",
      input: { text: "hi" },
      timeoutMs: 1000,
      traceId: "trace-runtime-001",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, backend: "local-text" });
  });

  it("exposes kind per runtime", () => {
    const registry = new RuntimeRegistry();
    registry.register({ ...stubRuntime("emb"), kind: "embedding" });
    expect(registry.get("emb")?.kind).toBe("embedding");
  });
});
