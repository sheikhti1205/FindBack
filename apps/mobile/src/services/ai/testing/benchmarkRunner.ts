/**
 * Model-lab benchmark runner (lab lane, never production).
 *
 * Static infrastructure only: runs one corpus case through an injected
 * adapter with a per-case timeout and cooperative cancel, then records
 * RAM/thermal samples from injected hooks. The adapter is a fixture fake in
 * host tests and a native bridge on the phone; the runner itself invents no
 * timings and performs no device I/O.
 */

import {
  DEVICE_REQUIRED_REASON,
  nullBenchmarkResourceHooks,
  type BenchmarkRamHook,
  type BenchmarkRamSample,
  type BenchmarkThermalHook,
  type BenchmarkThermalSample,
} from "./benchmarkResourceHooks";

export class BenchmarkTimeoutError extends Error {
  readonly caseId: string;
  readonly timeoutMs: number;
  constructor(caseId: string, timeoutMs: number) {
    super(`benchmark case ${caseId} timed out after ${timeoutMs}ms`);
    this.name = "BenchmarkTimeoutError";
    this.caseId = caseId;
    this.timeoutMs = timeoutMs;
  }
}

export class BenchmarkCancelledError extends Error {
  readonly caseId: string;
  constructor(caseId: string) {
    super(`benchmark case ${caseId} was cancelled`);
    this.name = "BenchmarkCancelledError";
    this.caseId = caseId;
  }
}

/** Injected inference seam: fixture fakes on host, native bridges on device. */
export interface BenchmarkLabAdapter {
  generateText(prompt: string, maxOutputTokens: number, signal: AbortSignal): Promise<string>;
  describeImage(
    imageRef: string,
    instruction: string,
    maxOutputTokens: number,
    signal: AbortSignal,
  ): Promise<string>;
}

export interface BenchmarkRunnerOptions {
  /** Per-case deadline in ms; exceeding it rejects with BenchmarkTimeoutError. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly ramHook?: BenchmarkRamHook;
  readonly thermalHook?: BenchmarkThermalHook;
}

export interface BenchmarkLabCaseRun {
  readonly caseId: string;
  readonly kind: "text" | "vision";
  readonly outputExcerpt: string;
  readonly ram: BenchmarkRamSample;
  readonly thermal: BenchmarkThermalSample;
}

function excerpt(output: string): string {
  return output.slice(0, 500);
}

function withBenchmarkDeadline<T>(
  caseId: string,
  work: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BenchmarkTimeoutError(caseId, timeoutMs));
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new BenchmarkCancelledError(caseId));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new BenchmarkCancelledError(caseId));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error instanceof DOMException && error.name === "AbortError") {
          reject(new BenchmarkCancelledError(caseId));
        } else {
          reject(error);
        }
      },
    );
  });
}

async function captureResources(
  ramHook: BenchmarkRamHook,
  thermalHook: BenchmarkThermalHook,
): Promise<{ readonly ram: BenchmarkRamSample; readonly thermal: BenchmarkThermalSample }> {
  let ram: BenchmarkRamSample;
  let thermal: BenchmarkThermalSample;
  try {
    ram = await ramHook.captureRam();
  } catch {
    ram = { pssMb: null, reason: DEVICE_REQUIRED_REASON };
  }
  try {
    thermal = await thermalHook.captureThermal();
  } catch {
    thermal = { state: null, reason: DEVICE_REQUIRED_REASON };
  }
  return { ram, thermal };
}

/** Runs one text case with timeout/cancel semantics. */
export async function runBenchmarkLabText(
  adapter: BenchmarkLabAdapter,
  input: { readonly caseId: string; readonly prompt: string; readonly maxOutputTokens: number },
  options: BenchmarkRunnerOptions,
): Promise<BenchmarkLabCaseRun> {
  const nulls = nullBenchmarkResourceHooks();
  const output = await withBenchmarkDeadline(
    input.caseId,
    adapter.generateText(input.prompt, input.maxOutputTokens, options.signal ?? new AbortController().signal),
    options.timeoutMs,
    options.signal,
  );
  const { ram, thermal } = await captureResources(
    options.ramHook ?? nulls.ramHook,
    options.thermalHook ?? nulls.thermalHook,
  );
  return { caseId: input.caseId, kind: "text", outputExcerpt: excerpt(output), ram, thermal };
}

/** Runs one vision case with timeout/cancel semantics. */
export async function runBenchmarkLabVision(
  adapter: BenchmarkLabAdapter,
  input: {
    readonly caseId: string;
    readonly imageRef: string;
    readonly instruction: string;
    readonly maxOutputTokens: number;
  },
  options: BenchmarkRunnerOptions,
): Promise<BenchmarkLabCaseRun> {
  const nulls = nullBenchmarkResourceHooks();
  const output = await withBenchmarkDeadline(
    input.caseId,
    adapter.describeImage(
      input.imageRef,
      input.instruction,
      input.maxOutputTokens,
      options.signal ?? new AbortController().signal,
    ),
    options.timeoutMs,
    options.signal,
  );
  const { ram, thermal } = await captureResources(
    options.ramHook ?? nulls.ramHook,
    options.thermalHook ?? nulls.thermalHook,
  );
  return { caseId: input.caseId, kind: "vision", outputExcerpt: excerpt(output), ram, thermal };
}
