/**
 * WS3 skeleton: LiteRT backend selector tests.
 *
 * No native bridge, no model bytes, no I/O: the selector is pure and the
 * probe evidence is hand-built. Covers the four stable-path gates —
 * cpu-default, gpu-denied-without-evidence, gpu-allowed-with-evidence,
 * stale-evidence-denied — plus the vision/language split independence.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISION_LANGUAGE_SPLIT,
  GPU_PROBE_EVIDENCE_TTL_MS,
  isGpuProbeEvidenceFresh,
  selectComputeBackend,
  selectVisionLanguageSplit,
  type GpuProbePassEvidence,
} from "./backendSelector";

const NOW_MS = 1_700_000_000_000;

function freshEvidence(
  overrides: Partial<GpuProbePassEvidence> = {},
): GpuProbePassEvidence {
  return {
    backend: "gpu",
    passed: true,
    measuredAtMs: NOW_MS - 60_000,
    ...overrides,
  };
}

describe("selectComputeBackend", () => {
  it("defaults to cpu when nothing is requested with evidence", () => {
    const selection = selectComputeBackend("cpu", undefined, NOW_MS);
    expect(selection).toEqual({
      requested: "cpu",
      selected: "cpu",
      allowed: true,
    });
  });

  it("denies gpu without evidence and resolves back to cpu", () => {
    const selection = selectComputeBackend("gpu", undefined, NOW_MS);
    expect(selection.selected).toBe("cpu");
    expect(selection.allowed).toBe(false);
    expect(selection.denialReason).toBe("no-evidence");
  });

  it("allows gpu with fresh measured probe-pass evidence", () => {
    const selection = selectComputeBackend("gpu", freshEvidence(), NOW_MS);
    expect(selection).toEqual({
      requested: "gpu",
      selected: "gpu",
      allowed: true,
    });
  });

  it("denies gpu on stale evidence and resolves back to cpu", () => {
    const stale = freshEvidence({
      measuredAtMs: NOW_MS - GPU_PROBE_EVIDENCE_TTL_MS - 1,
    });
    const selection = selectComputeBackend("gpu", stale, NOW_MS);
    expect(selection.selected).toBe("cpu");
    expect(selection.allowed).toBe(false);
    expect(selection.denialReason).toBe("stale-evidence");
  });

  it("denies gpu on future-dated evidence (not a measurement)", () => {
    const future = freshEvidence({ measuredAtMs: NOW_MS + 60_000 });
    const selection = selectComputeBackend("gpu", future, NOW_MS);
    expect(selection.selected).toBe("cpu");
    expect(selection.allowed).toBe(false);
    expect(selection.denialReason).toBe("stale-evidence");
  });
});

describe("isGpuProbeEvidenceFresh", () => {
  it("rejects missing evidence and malformed stamps", () => {
    expect(isGpuProbeEvidenceFresh(undefined, NOW_MS)).toBe(false);
    expect(
      isGpuProbeEvidenceFresh(freshEvidence({ measuredAtMs: Number.NaN }), NOW_MS),
    ).toBe(false);
  });

  it("accepts evidence measured exactly at the ttl boundary", () => {
    const boundary = freshEvidence({
      measuredAtMs: NOW_MS - GPU_PROBE_EVIDENCE_TTL_MS,
    });
    expect(isGpuProbeEvidenceFresh(boundary, NOW_MS)).toBe(true);
  });
});

describe("selectVisionLanguageSplit", () => {
  it("keeps the cpu/cpu stable default without any evidence", () => {
    const selection = selectVisionLanguageSplit(
      DEFAULT_VISION_LANGUAGE_SPLIT,
      {},
      NOW_MS,
    );
    expect(selection.effective).toEqual({ visionBackend: "cpu", languageBackend: "cpu" });
    expect(selection.vision.allowed).toBe(true);
    expect(selection.language.allowed).toBe(true);
  });

  it("gates each side independently: vision evidence never unlocks language gpu", () => {
    const selection = selectVisionLanguageSplit(
      { visionBackend: "gpu", languageBackend: "gpu" },
      { visionEvidence: freshEvidence() },
      NOW_MS,
    );
    expect(selection.effective).toEqual({
      visionBackend: "gpu",
      languageBackend: "cpu",
    });
    expect(selection.vision.allowed).toBe(true);
    expect(selection.language).toMatchObject({
      allowed: false,
      denialReason: "no-evidence",
    });
  });

  it("allows gpu on both sides only with per-side fresh evidence", () => {
    const selection = selectVisionLanguageSplit(
      { visionBackend: "gpu", languageBackend: "gpu" },
      { visionEvidence: freshEvidence(), languageEvidence: freshEvidence() },
      NOW_MS,
    );
    expect(selection.effective).toEqual({
      visionBackend: "gpu",
      languageBackend: "gpu",
    });
  });
});
