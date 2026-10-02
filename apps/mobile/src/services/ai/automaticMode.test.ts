import { describe, expect, it } from "vitest";
import { AUTOMATIC_FALLBACK_BACKEND, selectBackend } from "./automaticMode";
import { PROBE_VERSION, type ProbeContext, type ProbeRecord } from "./deviceProbe";

const CONTEXT: ProbeContext = {
  modelRev: "rev-a",
  probeVersion: PROBE_VERSION,
  corpusVersion: "ws6-v1",
};

function probe(overrides: Partial<ProbeRecord> = {}): ProbeRecord {
  return {
    socModel: "Test SoC",
    gpuInfo: "Test GPU",
    ramMb: 8192,
    osVersion: "Android 15",
    backend: "cpu",
    ttftMs: 200,
    tokensPerSec: 20,
    corpusVersion: CONTEXT.corpusVersion,
    probeVersion: CONTEXT.probeVersion,
    modelRev: CONTEXT.modelRev,
    correctnessPass: true,
    ...overrides,
  };
}

describe("automaticMode selectBackend", () => {
  it("selects the fastest correctness-passing probe", () => {
    const decision = selectBackend(
      [
        probe({ backend: "cpu", tokensPerSec: 20, ttftMs: 200 }),
        probe({ backend: "gpu", tokensPerSec: 42, ttftMs: 120 }),
        probe({ backend: "nnapi", tokensPerSec: 30, ttftMs: 150 }),
      ],
      CONTEXT,
    );
    expect(decision.kind).toBe("use");
    if (decision.kind === "use") expect(decision.backend).toBe("gpu");
  });

  it("never prefers a fast probe that fails correctness", () => {
    const decision = selectBackend(
      [
        probe({ backend: "gpu", tokensPerSec: 200, correctnessPass: false }),
        probe({ backend: "cpu", tokensPerSec: 20, correctnessPass: true }),
      ],
      CONTEXT,
    );
    expect(decision.kind).toBe("use");
    if (decision.kind === "use") expect(decision.backend).toBe("cpu");
  });

  it("ranks by measurement, never by SoC name", () => {
    const decision = selectBackend(
      [
        probe({ backend: "cpu", socModel: "Flagship X Elite", tokensPerSec: 10, ttftMs: 400 }),
        probe({ backend: "gpu", socModel: "Budget Y Lite", tokensPerSec: 50, ttftMs: 100 }),
      ],
      CONTEXT,
    );
    expect(decision.kind).toBe("use");
    if (decision.kind === "use") expect(decision.backend).toBe("gpu");
  });

  it("falls back to cpu with no probes", () => {
    const decision = selectBackend([], CONTEXT);
    expect(decision).toEqual({
      kind: "remeasure",
      reason: "no-probe",
      fallbackBackend: "cpu",
    });
    expect(AUTOMATIC_FALLBACK_BACKEND).toBe("cpu");
  });

  it("asks for re-measure when every probe is stale (no auto-prefer)", () => {
    const stale = probe({ backend: "gpu", tokensPerSec: 999, modelRev: "rev-old" });
    const decision = selectBackend([stale], CONTEXT);
    expect(decision).toEqual({
      kind: "remeasure",
      reason: "stale",
      fallbackBackend: "cpu",
    });
  });

  it("asks for re-measure when a model change stales the fleet", () => {
    const decision = selectBackend(
      [
        probe({ backend: "cpu", tokensPerSec: 20 }),
        probe({ backend: "gpu", tokensPerSec: 60 }),
      ],
      { ...CONTEXT, modelRev: "rev-b" },
    );
    expect(decision.kind).toBe("remeasure");
    if (decision.kind === "remeasure") {
      expect(decision.reason).toBe("stale");
      expect(decision.fallbackBackend).toBe("cpu");
    }
  });

  it("asks for re-measure when nothing fresh passes correctness", () => {
    const decision = selectBackend(
      [probe({ backend: "gpu", tokensPerSec: 60, correctnessPass: false })],
      CONTEXT,
    );
    expect(decision.kind).toBe("remeasure");
    if (decision.kind === "remeasure") {
      expect(decision.reason).toBe("none-passing");
      expect(decision.fallbackBackend).toBe("cpu");
    }
  });
});
