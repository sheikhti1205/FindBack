import { expect, it, vi } from "vitest";
import { CapacitorSmolVlmBridge, type SmolPlugin } from "./native";

const native = vi.hoisted(() => ({ plugin: null as unknown as SmolPlugin }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" }, registerPlugin: () => native.plugin }));

it("Stop waits for native cancellation before releasing the listener and runtime owner", async () => {
  const order: string[] = [];
  let started!: () => void;
  const inferenceStarted = new Promise<void>((resolve) => { started = resolve; });
  let cancelled!: () => void;
  const cancellationStarted = new Promise<void>((resolve) => { cancelled = resolve; });
  let finishInference!: () => void;
  let finishCancel!: () => void;
  let emit!: Parameters<SmolPlugin["addListener"]>[1];
  native.plugin = {
    isVisionAvailable: async () => ({ available: true }),
    loadVisionModel: async () => ({ ready: true }), unloadVisionModel: async () => {},
    collectDeviceFacts: async () => ({}), measureBackend: async () => ({ record: null }),
    addListener: async (_, callback) => { emit = callback; return { remove: async () => { order.push("listener-removed"); } }; },
    describeImage: () => { started(); return new Promise<void>((resolve) => { finishInference = resolve; }); },
    cancelGeneration: async () => {
      order.push("cancel-start"); cancelled();
      await new Promise<void>((resolve) => { finishCancel = resolve; });
      order.push("cancel-finish"); finishInference();
    },
  };
  const abort = new AbortController();
  const stream = new CapacitorSmolVlmBridge().describeImage({ generationId: "g1", prompt: "Describe", imageBase64: "bytes", maxOutputTokens: 24 }, abort.signal);
  const next = stream.next();
  await inferenceStarted;
  emit({ generationId: "g1", textDelta: "chunk queued at Stop" });
  abort.abort();
  await cancellationStarted;
  try {
    // Event-loop barrier: drain the aborted iterator while native cancellation stays held.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["cancel-start"]);
  } finally { finishCancel(); }
  expect((await next).done).toBe(true);
  expect(order).toEqual(["cancel-start", "cancel-finish", "listener-removed"]);
});
