import { describe, expect, it } from "vitest";
import {
  catalogueWarnings,
  getEntryById,
  isInstallable,
  licenseLabel,
  listByCategory,
  verificationLabel,
} from "./modelCatalogue";
import type { ModelCatalogueEntry } from "./catalogueTypes";

function entry(overrides: Partial<ModelCatalogueEntry> = {}): ModelCatalogueEntry {
  return {
    id: "test-entry",
    displayName: "Test Entry",
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
    description: "Test entry.",
    supportedCapabilities: ["text-generation"],
    upstreamRepo: "litert-community/Qwen3-0.6B",
    provenance: [{ kind: "UNKNOWN", ref: "unknown", note: "test" }],
    ...overrides,
  };
}

describe("licenseLabel", () => {
  it("records the LFM license as LFM Open License v1.0, never Apache", () => {
    expect(licenseLabel("lfm-open-1.0")).toBe("LFM Open License v1.0");
    expect(licenseLabel("apache-2.0")).toBe("Apache License 2.0");
    expect(licenseLabel("gemma")).toBe("Gemma Terms of Use (gated)");
  });
});

describe("verificationLabel", () => {
  it("labels every verification status", () => {
    expect(verificationLabel("VERIFIED")).toBe("Verified");
    expect(verificationLabel("SUPPORTED_UNVERIFIED")).toBe("Supported (unverified)");
    expect(verificationLabel("EXPERIMENTAL")).toBe("Experimental");
    expect(verificationLabel("INCOMPATIBLE")).toBe("Incompatible");
  });
});

describe("isInstallable", () => {
  it("allows a pinned supported entry", () => {
    expect(isInstallable(entry())).toBe(true);
  });

  it("refuses catalogue-only, experimental, and unpinned entries", () => {
    expect(isInstallable(entry({ catalogOnly: true }))).toBe(false);
    expect(isInstallable(entry({ verificationStatus: "EXPERIMENTAL" }))).toBe(false);
    expect(isInstallable(entry({ verificationStatus: "INCOMPATIBLE" }))).toBe(false);
    expect(isInstallable(entry({ downloadBytes: null }))).toBe(false);
    expect(isInstallable(entry({ installedBytes: null }))).toBe(false);
  });

  it("never offers the eval-only VL slot as installable", () => {
    expect(
      isInstallable(
        entry({ verificationStatus: "EXPERIMENTAL", downloadBytes: null }),
      ),
    ).toBe(false);
  });
});

describe("catalogueWarnings", () => {
  it("flags catalogue-only large entries with the estimate warning", () => {
    const warnings = catalogueWarnings(
      entry({
        catalogOnly: true,
        category: "experimental-large",
        verificationStatus: "EXPERIMENTAL",
      }),
    );
    expect(warnings.some((w) => w.includes("Catalog reference only"))).toBe(true);
    expect(warnings.some((w) => w.includes("conservative estimate"))).toBe(true);
  });

  it("marks supported-but-unverified entries", () => {
    expect(
      catalogueWarnings(entry()).some((w) => w.includes("unverified")),
    ).toBe(true);
  });
});

describe("getEntryById / listByCategory", () => {
  it("finds entries by id and returns null when absent", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" })];
    expect(getEntryById(entries, "b")?.id).toBe("b");
    expect(getEntryById(entries, "missing")).toBeNull();
  });

  it("orders by category then display name without mutating", () => {
    const text = entry({ id: "t", category: "text", displayName: "B" });
    const vision = entry({ id: "v", category: "vision", displayName: "Z" });
    const input = [text, vision];
    const ordered = listByCategory(input);
    expect(ordered.map((e) => e.id)).toEqual(["v", "t"]);
    expect(input.map((e) => e.id)).toEqual(["t", "v"]);
  });
});
