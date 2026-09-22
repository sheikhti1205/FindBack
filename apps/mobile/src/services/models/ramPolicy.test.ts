import { describe, expect, it } from "vitest";
import {
  describeRamFigures,
  formatRamGb,
  getRamBand,
  needsAdvancedConfirm,
  ramBandNote,
  ramSourceChip,
} from "./ramPolicy";
import type { ModelCatalogueEntry } from "./catalogueTypes";

const base: ModelCatalogueEntry = {
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
};

describe("formatRamGb", () => {
  it("formats MiB as ~X GB with one decimal", () => {
    expect(formatRamGb(1536)).toBe("~1.5 GB");
    expect(formatRamGb(1280)).toBe("~1.3 GB");
    expect(formatRamGb(2560)).toBe("~2.5 GB");
  });
});

describe("ramSourceChip", () => {
  it("distinguishes measured, vendor, and estimate sources", () => {
    expect(ramSourceChip("MEASURED")).toBe("Measured on-device");
    expect(ramSourceChip("VENDOR")).toBe("Vendor figure");
    expect(ramSourceChip("CONSERVATIVE_ESTIMATE")).toBe("Conservative estimate");
  });
});

describe("getRamBand", () => {
  it("derives OK / TIGHT / BELOW_MIN / UNKNOWN bands", () => {
    expect(getRamBand(base, 3000)).toBe("OK");
    expect(getRamBand(base, 2000)).toBe("TIGHT");
    expect(getRamBand(base, 1000)).toBe("BELOW_MIN");
    expect(getRamBand(base, null)).toBe("UNKNOWN");
  });

  it("treats the exact minimum as TIGHT, not below", () => {
    expect(getRamBand(base, 1280)).toBe("TIGHT");
    expect(getRamBand(base, 1279)).toBe("BELOW_MIN");
  });
});

describe("ramBandNote", () => {
  it("notes tight and below-minimum bands only", () => {
    expect(ramBandNote("OK")).toBeNull();
    expect(ramBandNote("UNKNOWN")).toBeNull();
    expect(ramBandNote("TIGHT")).toContain("Below recommended");
    expect(ramBandNote("BELOW_MIN")).toContain("Below minimum");
  });
});

describe("needsAdvancedConfirm", () => {
  it("triggers below minimum", () => {
    expect(needsAdvancedConfirm(base, 1000)).toBe(true);
    expect(needsAdvancedConfirm(base, 3000)).toBe(false);
  });

  it("always triggers for catalogue-only large entries", () => {
    const large: ModelCatalogueEntry = {
      ...base,
      catalogOnly: true,
      category: "experimental-large",
    };
    expect(needsAdvancedConfirm(large, 99999)).toBe(true);
  });

  it("never triggers on an unknown reading alone", () => {
    expect(needsAdvancedConfirm(base, null)).toBe(false);
  });
});

describe("describeRamFigures", () => {
  it("lists minimum / recommended / device-now in order", () => {
    const figures = describeRamFigures(base, 2000);
    expect(figures.minimumLabel).toBe("Minimum free RAM ~1.3 GB");
    expect(figures.recommendedLabel).toBe("Recommended ~2.5 GB");
    expect(figures.deviceNowLabel).toContain("Your device now:");
  });

  it("marks an unknown device reading explicitly", () => {
    expect(describeRamFigures(base, null).deviceNowLabel).toContain("unknown");
  });
});
