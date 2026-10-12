import { describe, expect, it } from "vitest";
import {
  DEVICE_REQUIRED_REASON,
  nullBenchmarkResourceHooks,
} from "./benchmarkResourceHooks";
import {
  BenchmarkCancelledError,
  BenchmarkTimeoutError,
  runBenchmarkLabText,
  runBenchmarkLabVision,
  type BenchmarkLabAdapter,
} from "./benchmarkRunner";

function hangingAdapter(): BenchmarkLabAdapter {
  return {
    generateText: () => new Promise<string>(() => {}),
    describeImage: () => new Promise<string>(() => {}),
  };
}

function slowAdapter(delayMs: number, text: string): BenchmarkLabAdapter {
  return {
    generateText: (_prompt, _budget, signal) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve(text), delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    describeImage: async () => text,
  };
}

describe("benchmarkRunner timeout", () => {
  it("rejects with BenchmarkTimeoutError when the deadline passes", async () => {
    await expect(
      runBenchmarkLabText(
        hangingAdapter(),
        { caseId: "bench-t-help-en", prompt: "hi", maxOutputTokens: 256 },
        { timeoutMs: 20 },
      ),
    ).rejects.toBeInstanceOf(BenchmarkTimeoutError);
    await expect(
      runBenchmarkLabVision(
        hangingAdapter(),
        {
          caseId: "bench-v-ordinary",
          imageRef: "assets/lab-bench/ordinary.png",
          instruction: "describe",
          maxOutputTokens: 512,
        },
        { timeoutMs: 20 },
      ),
    ).rejects.toBeInstanceOf(BenchmarkTimeoutError);
  });
});

describe("benchmarkRunner cancel", () => {
  it("rejects with BenchmarkCancelledError when aborted mid-flight", async () => {
    const controller = new AbortController();
    const pending = runBenchmarkLabText(
      slowAdapter(500, "late output"),
      { caseId: "bench-t-help-en", prompt: "hi", maxOutputTokens: 256 },
      { timeoutMs: 5000, signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(BenchmarkCancelledError);
  });

  it("rejects immediately for a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runBenchmarkLabText(
        slowAdapter(10, "output"),
        { caseId: "bench-t-help-en", prompt: "hi", maxOutputTokens: 256 },
        { timeoutMs: 5000, signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(BenchmarkCancelledError);
  });
});

describe("benchmarkRunner resource hooks", () => {
  it("records injected hook samples on success", async () => {
    const run = await runBenchmarkLabText(
      slowAdapter(5, '{"title":"found keys"}'),
      { caseId: "bench-t-report-en", prompt: "extract", maxOutputTokens: 256 },
      {
        timeoutMs: 5000,
        ramHook: { captureRam: async () => ({ pssMb: 812, reason: "device-probe" }) },
        thermalHook: { captureThermal: async () => ({ state: "moderate", reason: "device-probe" }) },
      },
    );
    expect(run.kind).toBe("text");
    expect(run.outputExcerpt).toBe('{"title":"found keys"}');
    expect(run.ram).toEqual({ pssMb: 812, reason: "device-probe" });
    expect(run.thermal).toEqual({ state: "moderate", reason: "device-probe" });
  });

  it("falls back to device-required sentinels without hooks", async () => {
    const run = await runBenchmarkLabVision(
      slowAdapter(5, '{"object":"umbrella"}'),
      {
        caseId: "bench-v-ordinary",
        imageRef: "assets/lab-bench/ordinary.png",
        instruction: "describe",
        maxOutputTokens: 512,
      },
      { timeoutMs: 5000 },
    );
    expect(run.ram).toEqual({ pssMb: null, reason: DEVICE_REQUIRED_REASON });
    expect(run.thermal).toEqual({ state: null, reason: DEVICE_REQUIRED_REASON });
    const nulls = nullBenchmarkResourceHooks();
    expect(await nulls.ramHook.captureRam()).toEqual({ pssMb: null, reason: DEVICE_REQUIRED_REASON });
    expect(await nulls.thermalHook.captureThermal()).toEqual({
      state: null,
      reason: DEVICE_REQUIRED_REASON,
    });
  });
});
