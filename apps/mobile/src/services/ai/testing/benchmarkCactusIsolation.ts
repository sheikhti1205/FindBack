/**
 * Model-lab Cactus challenger isolation (lab lane, never production).
 *
 * Static infrastructure only: the challenger seam that lets a device run
 * compare the unified `cactus-lab` runtime against the working lane runtimes
 * without replacing them. Lab channels (benchmark/eval) only — any other
 * channel throws before any native call. License and pin gates run first via
 * `benchmarkDownloadGate.ts`. No native calls, no weights, no production
 * wiring here; the device run injects the bridge explicitly per run.
 */

import type { BenchmarkCandidateMeta } from "./benchmarkCandidateSchema";
import { evaluateBenchmarkDownloadGate } from "./benchmarkDownloadGate";

export const BENCHMARK_CACTUS_RUNTIME = "cactus-lab" as const;

export const BENCHMARK_CACTUS_CHANNELS = ["benchmark", "eval"] as const;
export type BenchmarkCactusChannel = (typeof BENCHMARK_CACTUS_CHANNELS)[number];

export class BenchmarkCactusChannelError extends Error {
  readonly channel: string;
  constructor(channel: string) {
    super(`cactus challenger requires a lab channel (benchmark/eval), got ${channel}`);
    this.name = "BenchmarkCactusChannelError";
    this.channel = channel;
  }
}

export class BenchmarkCactusBlockedError extends Error {
  readonly modelId: string;
  constructor(modelId: string, reason: string) {
    super(`cactus challenger blocked for ${modelId}: ${reason}`);
    this.name = "BenchmarkCactusBlockedError";
    this.modelId = modelId;
  }
}

/** True only for the unified lab challenger id. */
export function isBenchmarkCactusRuntime(runtimeId: string): boolean {
  return runtimeId === BENCHMARK_CACTUS_RUNTIME;
}

/** True only for lab channels. */
export function isBenchmarkCactusChannel(channel: string): channel is BenchmarkCactusChannel {
  return (BENCHMARK_CACTUS_CHANNELS as readonly string[]).includes(channel);
}

/** Throws BenchmarkCactusChannelError unless the channel is a lab channel. */
export function assertBenchmarkCactusChannel(channel: string): asserts channel is BenchmarkCactusChannel {
  if (!isBenchmarkCactusChannel(channel)) throw new BenchmarkCactusChannelError(channel);
}

export interface BenchmarkCactusLoadDecision {
  readonly allowed: boolean;
  readonly fixtureOnly: boolean;
  readonly reason: string;
}

/**
 * Fail-closed load check for one candidate on a lab channel. Throws on
 * non-lab channels and on weight-blocked candidates; fixture runs (no
 * weights) stay allowed. Pure; performs no native call.
 */
export function checkBenchmarkCactusLoad(
  candidate: BenchmarkCandidateMeta,
  channel: string,
): BenchmarkCactusLoadDecision {
  assertBenchmarkCactusChannel(channel);
  if (candidate.runtime !== BENCHMARK_CACTUS_RUNTIME && candidate.runtime !== "litert-lm" && candidate.runtime !== "llama-cpp" && candidate.runtime !== "needle-cact") {
    throw new BenchmarkCactusBlockedError(candidate.modelId, `unknown lab runtime ${candidate.runtime}`);
  }
  const gate = evaluateBenchmarkDownloadGate(candidate, channel);
  if (!gate.allowed) {
    throw new BenchmarkCactusBlockedError(candidate.modelId, gate.reason);
  }
  return { allowed: true, fixtureOnly: true, reason: gate.reason };
}
