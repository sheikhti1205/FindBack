import { afterEach, expect, it, vi } from "vitest";
import { CapacitorSmolVlmBridge, type SmolPlugin } from "./native";
import { clearDiagEvents, getDiagEvents, setDiagEnabled } from "../../diag";

const native = vi.hoisted(() => ({ plugin: null as unknown as SmolPlugin }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" }, registerPlugin: () => native.plugin }));

afterEach(() => { vi.restoreAllMocks(); setDiagEnabled(false); clearDiagEvents(); });

it("measures actual bridge arrival cadence with numeric-only fields and ignores foreign/terminal chunks", async () => {
  setDiagEnabled(true);
  let ms = 0; vi.spyOn(performance, "now").mockImplementation(() => ms);
  let emit!: Parameters<SmolPlugin["addListener"]>[1];
  native.plugin = {
    isVisionAvailable: async () => ({ available: true }),
    loadVisionModel: async () => ({ ready: true }), unloadVisionModel: async () => {},
    collectDeviceFacts: async () => ({}), measureBackend: async () => ({ record: null }),
    addListener: async (_, callback) => { emit = callback; return { remove: async () => {} }; },
    describeImage: async () => {
      emit({ generationId: "foreign-private-id", textDelta: "foreign private text" });
      ms = 20; emit({ generationId: "private-id", textDelta: "real " });
      ms = 70; emit({ generationId: "private-id", textDelta: "delta" });
      emit({ generationId: "private-id", done: true });
      emit({ generationId: "private-id", textDelta: "late private text" });
    },
    cancelGeneration: async () => {},
  };
  const output: string[] = [];
  for await (const chunk of new CapacitorSmolVlmBridge().describeImage({ generationId: "private-id", prompt: "private prompt", imageBase64: "private photo", maxOutputTokens: 24 }, new AbortController().signal)) output.push(chunk.textDelta);
  expect(output).toEqual(["real ", "delta"]);
  const events = getDiagEvents().filter(e => e.event.startsWith("ai.stream.bridge"));
  expect(events.at(-1)?.fields).toMatchObject({ chunkCount: 2, firstChunkMs: 20, lastChunkMs: 70, chunkIntervalMs: 50 });
  expect(events.every(e => Object.values(e.fields).every(v => typeof v === "number"))).toBe(true);
  expect(JSON.stringify(events)).not.toMatch(/private|foreign|real |delta/);
});

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
