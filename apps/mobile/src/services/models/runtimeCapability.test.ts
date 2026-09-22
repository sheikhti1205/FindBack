import { describe, expect, it } from "vitest";
import {
  availabilityForEntry,
  availabilityLabel,
  canOfferActivation,
  NO_RUNTIME_MESSAGE,
  runtimeCapabilityForEntry,
} from "./runtimeCapability";
import { SHIPPED_CATALOGUE_ENTRIES } from "./shippedCatalogue";
import type { ModelCatalogueEntry } from "./catalogueTypes";

function entry(overrides: Partial<ModelCatalogueEntry> = {}): ModelCatalogueEntry {
  return {
    id: "smolvlm2-500m-litert-int4",
    displayName: "SmolVLM2 500M (LiteRT, int4)",
    category: "vision",
    role: "report-from-photo",
    runtime: "litert-lm",
    format: "litertlm",
    revision: "dad030b6",
    license: "apache-2.0",
    downloadBytes: 360822960,
    installedBytes: 360822960,
    sha256: null,
    minFreeRamMb: 1536,
    recommendedFreeRamMb: 2560,
    ramRequirementSource: "CONSERVATIVE_ESTIMATE",
    verificationStatus: "VERIFIED",
    description: "Test entry.",
    supportedCapabilities: ["report-from-photo"],
    upstreamRepo: "litert-community/SmolVLM2-500M",
    provenance: [{ kind: "UNKNOWN", ref: "unknown", note: "test" }],
    ...overrides,
  };
}

describe("runtimeCapabilityForEntry", () => {
  it("reports a wired runtime only for the native runtime-backed entry", () => {
    expect(runtimeCapabilityForEntry("smolvlm2-500m-litert-int4")).toBe(
      "RUNTIME_AVAILABLE",
    );
  });

  it("reports no runtime for every other shipped entry", () => {
    for (const shipped of SHIPPED_CATALOGUE_ENTRIES) {
      if (shipped.id === "smolvlm2-500m-litert-int4") continue;
      expect(runtimeCapabilityForEntry(shipped.id), shipped.id).toBe(
        "RUNTIME_UNAVAILABLE",
      );
    }
  });

  it("reports unknown for ids outside the shipped catalogue", () => {
    expect(runtimeCapabilityForEntry("not-a-model")).toBe("UNKNOWN");
    expect(runtimeCapabilityForEntry("")).toBe("UNKNOWN");
  });

  it("never offers activation without a wired runtime", () => {
    expect(canOfferActivation("RUNTIME_AVAILABLE")).toBe(true);
    expect(canOfferActivation("RUNTIME_UNAVAILABLE")).toBe(false);
    expect(canOfferActivation("UNKNOWN")).toBe(false);
  });
});

describe("availabilityForEntry", () => {
  it("marks catalogue-only entries before anything else", () => {
    expect(
      availabilityForEntry(entry({ catalogOnly: true }), {
        bridgeId: "smolvlm2-500m",
        installed: true,
        isActive: true,
      }),
    ).toBe("CATALOG_ONLY");
  });

  it("marks entries with no wired runtime as unavailable, never downloadable", () => {
    expect(
      availabilityForEntry(
        entry({ id: "qwen3-0.6b-litert-dynamic-int4" }),
        { bridgeId: null, installed: false, isActive: false },
      ),
    ).toBe("RUNTIME_UNAVAILABLE");
  });

  it("walks the downloadable → installed → active ladder for wired entries", () => {
    expect(
      availabilityForEntry(entry(), {
        bridgeId: "smolvlm2-500m",
        installed: false,
        isActive: false,
      }),
    ).toBe("DOWNLOADABLE");
    expect(
      availabilityForEntry(entry(), {
        bridgeId: "smolvlm2-500m",
        installed: true,
        isActive: false,
      }),
    ).toBe("INSTALLED");
    expect(
      availabilityForEntry(entry(), {
        bridgeId: "smolvlm2-500m",
        installed: true,
        isActive: true,
      }),
    ).toBe("ACTIVE");
  });

  it("keeps the eval-only VL slot non-runnable and non-downloadable", () => {
    const vlSlot = SHIPPED_CATALOGUE_ENTRIES.find(
      (shipped) => shipped.id === "lfm2.5-vl-450m",
    );
    expect(vlSlot).toBeDefined();
    expect(runtimeCapabilityForEntry("lfm2.5-vl-450m")).toBe(
      "RUNTIME_UNAVAILABLE",
    );
    expect(canOfferActivation("RUNTIME_UNAVAILABLE")).toBe(false);
    expect(
      availabilityForEntry(vlSlot!, {
        bridgeId: null,
        installed: false,
        isActive: false,
      }),
    ).toBe("RUNTIME_UNAVAILABLE");
  });

  it("labels every availability without implying executability", () => {
    expect(availabilityLabel("CATALOG_ONLY")).toBe("Catalog reference only");
    expect(availabilityLabel("DOWNLOADABLE")).toBe("Available to download");
    expect(availabilityLabel("INSTALLED")).toBe("Installed");
    expect(availabilityLabel("RUNTIME_UNAVAILABLE")).toBe(
      "No executable runtime in this build",
    );
    expect(availabilityLabel("ACTIVE")).toBe("Active");
  });

  it("states runtime absence in plain language", () => {
    expect(NO_RUNTIME_MESSAGE).toContain("No executable runtime");
    expect(NO_RUNTIME_MESSAGE).toContain("cannot run or be activated here");
  });
});
