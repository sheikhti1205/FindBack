import { describe, expect, it } from "vitest";
import {
  BENCHMARK_CANDIDATES,
  validateBenchmarkCandidate,
  validateBenchmarkCandidates,
  type BenchmarkCandidateMeta,
} from "./benchmarkCandidateSchema";

function validEntry(): BenchmarkCandidateMeta {
  const found = BENCHMARK_CANDIDATES.find((c) => c.modelId === "qwen3-0.6b-dynamic-int4");
  if (found === undefined) throw new Error("static list must hold qwen3-0.6b-dynamic-int4");
  return { ...found, taskRoles: [...found.taskRoles] };
}

describe("benchmarkCandidateSchema", () => {
  it("accepts the static unmeasured candidate list", () => {
    expect(validateBenchmarkCandidates(BENCHMARK_CANDIDATES)).toEqual([]);
    expect(BENCHMARK_CANDIDATES.length).toBeGreaterThanOrEqual(10);
  });

  it("keeps every entry unmeasured with byte-size and pin fields present", () => {
    for (const candidate of BENCHMARK_CANDIDATES) {
      expect(candidate.measured).toBe(false);
      expect("artifactBytes" in candidate).toBe(true);
      expect("revision" in candidate).toBe(true);
      expect("sha256" in candidate).toBe(true);
      expect("license" in candidate).toBe(true);
      expect(JSON.stringify(candidate)).not.toMatch(/recommend/i);
    }
  });

  it("rejects bad pins, byte sizes, licenses, and duplicates", () => {
    const badRevision = { ...validEntry(), modelId: "x1", revision: "abc" };
    expect(validateBenchmarkCandidate(badRevision).join("\n")).toMatch(/revision/);
    const badSha = { ...validEntry(), modelId: "x2", sha256: "zz" };
    expect(validateBenchmarkCandidate(badSha).join("\n")).toMatch(/sha256/);
    const badBytes = { ...validEntry(), modelId: "x3", artifactBytes: -5 };
    expect(validateBenchmarkCandidate(badBytes).join("\n")).toMatch(/artifactBytes/);
    const lfmBundle = {
      ...validEntry(),
      modelId: "x4",
      license: "LFM-1.0",
      redistribution: "redistributable" as const,
    };
    expect(validateBenchmarkCandidate(lfmBundle).join("\n")).toMatch(/benchmark-eval-only/);
    const measured = { ...validEntry(), modelId: "x5", measured: true as never };
    expect(validateBenchmarkCandidate(measured).join("\n")).toMatch(/unmeasured/);
    const dupes = [validEntry(), validEntry()];
    expect(validateBenchmarkCandidates(dupes).join("\n")).toMatch(/duplicate modelId/);
  });

  it("rejects non-object values", () => {
    expect(validateBenchmarkCandidate(null)).toHaveLength(1);
    expect(validateBenchmarkCandidate("qwen3")).toHaveLength(1);
  });
});
