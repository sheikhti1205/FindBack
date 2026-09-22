import { describe, expect, it } from "vitest";
import {
  bridgeModelIdForEntry,
  distributionUrlForEntry,
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
        "releaseAsset",
        "distribution",
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

  it("pins GitHub Release distribution for the two v1 packages", () => {
    const fiveHundred = SHIPPED_CATALOGUE_ENTRIES.find(
      (entry) => entry.id === "smolvlm2-500m-litert-int4",
    );
    expect(fiveHundred?.distribution).toMatchObject({
      repo: "sheikhti1205/FindBack-Models",
      tag: "models-2026-09-22-v1",
      asset: "smolvlm2-500m-litert-int4.fbmodel",
      bytes: 360823868,
      sha256:
        "41e11106a57ae750f61d992ab195f90b9f7bc58c39009b5dac0ce9d1c60a366e",
      parts: null,
    });
    const qwen = SHIPPED_CATALOGUE_ENTRIES.find(
      (entry) => entry.id === "qwen3-0.6b-litert-dynamic-int4",
    );
    expect(qwen?.distribution).toMatchObject({
      repo: "sheikhti1205/FindBack-Models",
      tag: "models-2026-09-22-v1",
      asset: "qwen3-0.6b-litert-dynamic-int4.fbmodel",
      bytes: 344672713,
      sha256:
        "8a8a2d5747aa804c8f39e79658d2b3e5962f0451e0e16571b6bdb9dcd8205821",
      parts: null,
    });
    for (const entry of SHIPPED_CATALOGUE_ENTRIES) {
      if (
        entry.id !== "smolvlm2-500m-litert-int4" &&
        entry.id !== "qwen3-0.6b-litert-dynamic-int4"
      ) {
        expect(entry.distribution ?? null, entry.id).toBeNull();
      }
    }
  });

  it("builds pinned release-asset URLs without polling or mutable refs", () => {
    const fiveHundred = SHIPPED_CATALOGUE_ENTRIES.find(
      (entry) => entry.id === "smolvlm2-500m-litert-int4",
    );
    expect(fiveHundred && distributionUrlForEntry(fiveHundred)).toBe(
      "https://github.com/sheikhti1205/FindBack-Models/releases/download/models-2026-09-22-v1/smolvlm2-500m-litert-int4.fbmodel",
    );
    const qwen = SHIPPED_CATALOGUE_ENTRIES.find(
      (entry) => entry.id === "qwen3-0.6b-litert-dynamic-int4",
    );
    expect(qwen && distributionUrlForEntry(qwen)).toBe(
      "https://github.com/sheikhti1205/FindBack-Models/releases/download/models-2026-09-22-v1/qwen3-0.6b-litert-dynamic-int4.fbmodel",
    );
    for (const entry of SHIPPED_CATALOGUE_ENTRIES) {
      const url = distributionUrlForEntry(entry);
      if (url != null) {
        expect(url).not.toContain("huggingface.co");
        expect(url).not.toContain("latest");
        expect(url).not.toContain("/main");
      }
    }
    const gemma = SHIPPED_CATALOGUE_ENTRIES.find(
      (entry) => entry.id === "gemma-3n-e2b-it-litert-int4",
    );
    expect(gemma && distributionUrlForEntry(gemma)).toBeNull();
  });
});
