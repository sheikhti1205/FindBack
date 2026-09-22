import { describe, expect, it } from "vitest";
import {
  bridgeModelIdForEntry,
  SHIPPED_CATALOGUE_ENTRIES,
  SHIPPED_CATALOGUE_VERSION,
} from "./shippedCatalogue";
import { isInstallable } from "./modelCatalogue";
import catalogueJson from "../../../../../docs/specs/model-library/catalogue.v1.json";

describe("shipped catalogue", () => {
  it("ships catalogue version 1 with the pinned entries", () => {
    expect(SHIPPED_CATALOGUE_VERSION).toBe("1");
    expect(SHIPPED_CATALOGUE_ENTRIES.length).toBeGreaterThan(0);
    expect(
      SHIPPED_CATALOGUE_ENTRIES.map((entry) => entry.id),
    ).toContain("smolvlm2-500m-litert-int4");
  });

  it("matches the pinned catalogue file field-for-field", () => {
    const pinned = catalogueJson as unknown as {
      entries: Record<string, unknown>[];
    };
    expect(SHIPPED_CATALOGUE_ENTRIES.length).toBe(pinned.entries.length);
    for (const shipped of SHIPPED_CATALOGUE_ENTRIES) {
      const source = pinned.entries.find((entry) => entry["id"] === shipped.id);
      expect(source).toBeDefined();
      for (const field of [
        "displayName",
        "category",
        "role",
        "runtime",
        "format",
        "revision",
        "license",
        "downloadBytes",
        "installedBytes",
        "sha256",
        "minFreeRamMb",
        "recommendedFreeRamMb",
        "ramRequirementSource",
        "verificationStatus",
        "catalogOnly",
        "upstreamRepo",
        "upstreamFile",
      ] as const) {
        expect(
          (shipped as unknown as Record<string, unknown>)[field],
          `${shipped.id}.${field}`,
        ).toEqual(source?.[field]);
      }
    }
  });

  it("maps only the verified 500M entry to a native runtime", () => {
    expect(bridgeModelIdForEntry("smolvlm2-500m-litert-int4")).toBe(
      "smolvlm2-500m",
    );
    for (const entry of SHIPPED_CATALOGUE_ENTRIES) {
      if (entry.id !== "smolvlm2-500m-litert-int4") {
        expect(bridgeModelIdForEntry(entry.id)).toBeNull();
      }
    }
  });

  it("never distributes the eval-only VL fixB bytes", () => {
    const fixBHash =
      "6854cd9677a34e680070b60076793e49aeb3224de7cb4101076b261cb9bf6033";
    for (const entry of SHIPPED_CATALOGUE_ENTRIES) {
      expect(entry.sha256, entry.id).not.toBe(fixBHash);
      expect(entry.id.toLowerCase().includes("fixb")).toBe(false);
    }
    const vlSlot = SHIPPED_CATALOGUE_ENTRIES.find(
      (entry) => entry.id === "lfm2.5-vl-450m",
    );
    expect(vlSlot).toBeDefined();
    expect(isInstallable(vlSlot!)).toBe(false);
    expect(bridgeModelIdForEntry("lfm2.5-vl-450m")).toBeNull();
  });
});
