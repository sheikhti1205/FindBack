import { describe, expect, it } from "vitest";
import { BENCHMARK_CANDIDATES, benchmarkCandidateFor } from "./benchmarkCandidateSchema";
import {
  evaluateBenchmarkDownloadGate,
  isBenchmarkWeightFetchAllowed,
} from "./benchmarkDownloadGate";

describe("benchmarkDownloadGate", () => {
  it("blocks weight channels for unverified pins", () => {
    const candidate = benchmarkCandidateFor("qwen3-1.7b-dynamic-int4");
    if (candidate === undefined) throw new Error("missing static entry");
    expect(evaluateBenchmarkDownloadGate(candidate, "bundle").allowed).toBe(false);
    expect(evaluateBenchmarkDownloadGate(candidate, "download").allowed).toBe(false);
    expect(isBenchmarkWeightFetchAllowed(candidate, "download")).toBe(false);
  });

  it("blocks weight channels for eval-only licenses", () => {
    const candidate = benchmarkCandidateFor("lfm2-350m-q4_0");
    if (candidate === undefined) throw new Error("missing static entry");
    expect(evaluateBenchmarkDownloadGate(candidate, "download").allowed).toBe(false);
    expect(evaluateBenchmarkDownloadGate(candidate, "download").reason).toMatch(/eval-only/);
  });

  it("blocks weight channels while byte size is unconfirmed", () => {
    for (const candidate of BENCHMARK_CANDIDATES) {
      expect(evaluateBenchmarkDownloadGate(candidate, "download").allowed).toBe(false);
    }
  });

  it("allows lab channels for fixture-only runs without fetching weights", () => {
    for (const candidate of BENCHMARK_CANDIDATES) {
      const decision = evaluateBenchmarkDownloadGate(candidate, "benchmark");
      expect(decision.allowed).toBe(true);
      expect(decision.reason).toMatch(/no artifact fetch/);
    }
    const candidate = benchmarkCandidateFor("lfm2-vl-450m-int4");
    if (candidate === undefined) throw new Error("missing static entry");
    expect(isBenchmarkWeightFetchAllowed(candidate, "benchmark")).toBe(false);
    expect(isBenchmarkWeightFetchAllowed(candidate, "eval")).toBe(false);
  });
});
