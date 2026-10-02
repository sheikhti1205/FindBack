import { describe, expect, it } from "vitest";
import {
  PROBE_VERSION,
  isProbeStale,
  validateProbeRecord,
  type ProbeInvalidationKey,
  type ProbeRecord,
} from "./deviceProbe";

function probe(overrides: Partial<ProbeRecord> = {}): ProbeRecord {
  return {
    socModel: "Test SoC",
    gpuInfo: "Test GPU",
    ramMb: 8192,
    osVersion: "Android 15",
    backend: "gpu",
    ttftMs: 120,
    tokensPerSec: 42,
    corpusVersion: "ws6-v1",
    probeVersion: PROBE_VERSION,
    modelRev: "rev-a",
    correctnessPass: true,
    ...overrides,
  };
}

function current(overrides: Partial<ProbeInvalidationKey> = {}): ProbeInvalidationKey {
  return {
    modelRev: "rev-a",
    backend: "gpu",
    probeVersion: PROBE_VERSION,
    corpusVersion: "ws6-v1",
    ...overrides,
  };
}

describe("deviceProbe isProbeStale", () => {
  it("is fresh when model rev, backend, probe version, and corpus all match", () => {
    expect(isProbeStale(probe(), current())).toBe(false);
  });

  it("is stale on model change", () => {
    expect(isProbeStale(probe(), current({ modelRev: "rev-b" }))).toBe(true);
    expect(isProbeStale(probe({ modelRev: "rev-a" }), current({ modelRev: "rev-b" }))).toBe(true);
  });

  it("is stale on backend change", () => {
    expect(isProbeStale(probe(), current({ backend: "cpu" }))).toBe(true);
  });

  it("is stale on probe-version change", () => {
    expect(isProbeStale(probe(), current({ probeVersion: PROBE_VERSION + 1 }))).toBe(true);
  });

  it("is stale on corpus change", () => {
    expect(isProbeStale(probe(), current({ corpusVersion: "ws6-v2" }))).toBe(true);
  });
});

describe("deviceProbe validateProbeRecord", () => {
  it("accepts a well-formed probe", () => {
    expect(validateProbeRecord(probe())).toEqual([]);
  });

  it("rejects non-positive measurements", () => {
    expect(validateProbeRecord(probe({ ttftMs: 0 }))).not.toEqual([]);
    expect(validateProbeRecord(probe({ tokensPerSec: Number.NaN }))).not.toEqual([]);
  });
});
