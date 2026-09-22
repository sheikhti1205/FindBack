import { describe, expect, it } from "vitest";
import {
  MAX_RESIDENT_GENERATIVE_MODELS,
  MODEL_SWITCH_STEPS,
  planModelSwitch,
} from "./modelSession";
import type { ModelCatalogueEntry } from "./catalogueTypes";

function entry(overrides: Partial<ModelCatalogueEntry> = {}): ModelCatalogueEntry {
  return {
    id: "qwen3-0.6b-litert-dynamic-int4",
    displayName: "Qwen3 0.6B (LiteRT, dynamic int4)",
    category: "text",
    role: "chat-text",
    runtime: "litert-lm",
    format: "litertlm",
    revision: "a3c5d805",
    license: "apache-2.0",
    downloadBytes: 344671744,
    installedBytes: 344671744,
    sha256: null,
    minFreeRamMb: 1280,
    recommendedFreeRamMb: 2560,
    ramRequirementSource: "CONSERVATIVE_ESTIMATE",
    verificationStatus: "SUPPORTED_UNVERIFIED",
    description: "First text target.",
    supportedCapabilities: ["text-generation"],
    upstreamRepo: "litert-community/Qwen3-0.6B",
    provenance: [{ kind: "UNKNOWN", ref: "unknown", note: "test" }],
    ...overrides,
  };
}

describe("single-resident invariant (G7)", () => {
  it("allows at most one resident generative model", () => {
    expect(MAX_RESIDENT_GENERATIVE_MODELS).toBe(1);
  });
});

describe("planModelSwitch", () => {
  it("returns no steps when the target is already resident", () => {
    const plan = planModelSwitch({
      currentResidentId: "qwen3-0.6b-litert-dynamic-int4",
      target: entry(),
      availableFreeRamMb: 3000,
      advancedConfirmed: false,
      // Same-id short-circuits before the runtime gate.
      runtimeCapability: "RUNTIME_UNAVAILABLE",
    });
    expect(plan).toEqual({ blocked: false, steps: [] });
  });

  it("plans cancel → release → verify-memory → init in order", () => {
    const plan = planModelSwitch({
      currentResidentId: "smolvlm2-500m-litert-int4",
      target: entry(),
      availableFreeRamMb: 3000,
      advancedConfirmed: false,
      runtimeCapability: "RUNTIME_AVAILABLE",
    });
    expect(plan).toEqual({ blocked: false, steps: MODEL_SWITCH_STEPS });
    expect(MODEL_SWITCH_STEPS).toEqual([
      "cancel",
      "release",
      "verify-memory",
      "init",
    ]);
  });

  it("blocks catalogue-only entries even with confirmation", () => {
    const plan = planModelSwitch({
      currentResidentId: null,
      target: entry({ id: "gemma", catalogOnly: true }),
      availableFreeRamMb: 99999,
      advancedConfirmed: true,
      runtimeCapability: "RUNTIME_AVAILABLE",
    });
    expect(plan.blocked).toBe(true);
  });

  it("blocks experimental eval-only entries", () => {
    const plan = planModelSwitch({
      currentResidentId: null,
      target: entry({
        id: "lfm2.5-vl-450m",
        verificationStatus: "EXPERIMENTAL",
      }),
      availableFreeRamMb: 99999,
      advancedConfirmed: true,
      runtimeCapability: "RUNTIME_AVAILABLE",
    });
    expect(plan.blocked).toBe(true);
  });

  it("blocks below-minimum activation without advanced confirmation", () => {
    const blocked = planModelSwitch({
      currentResidentId: null,
      target: entry(),
      availableFreeRamMb: 512,
      advancedConfirmed: false,
      runtimeCapability: "RUNTIME_AVAILABLE",
    });
    expect(blocked.blocked).toBe(true);
  });

  it("plans the full sequence once advanced confirmation is recorded", () => {
    const plan = planModelSwitch({
      currentResidentId: null,
      target: entry(),
      availableFreeRamMb: 512,
      advancedConfirmed: true,
      runtimeCapability: "RUNTIME_AVAILABLE",
    });
    expect(plan).toEqual({ blocked: false, steps: MODEL_SWITCH_STEPS });
  });

  it("never offers activation without a wired executable runtime", () => {
    for (const capability of ["RUNTIME_UNAVAILABLE", "UNKNOWN"] as const) {
      const blocked = planModelSwitch({
        currentResidentId: null,
        target: entry(),
        availableFreeRamMb: 99999,
        advancedConfirmed: true,
        runtimeCapability: capability,
      });
      expect(blocked.blocked).toBe(true);
      if (blocked.blocked) {
        expect(blocked.reason).toMatch(/no executable runtime/i);
      }
    }
  });
});
