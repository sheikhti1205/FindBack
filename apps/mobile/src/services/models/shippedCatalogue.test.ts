import { describe, expect, it } from "vitest";
import {
  bridgeModelIdForEntry,
  distributionUrlForEntry,
  rawWeightUrlForEntry,
  hasUnpublishedDistribution,
  isDistributionPublished,
  SHIPPED_CATALOGUE_ENTRIES,
  SHIPPED_CATALOGUE_VERSION,
} from "./shippedCatalogue";
import { isInstallable } from "./modelCatalogue";
import catalogueJson from "../../../../../docs/specs/model-library/catalogue.v1.json";

describe("shipped catalogue", () => {
  it("offers exactly the six owner-selected model identities and excludes Gemma", () => {
    expect(SHIPPED_CATALOGUE_ENTRIES.map((entry) => entry.id)).toEqual([
      "smolvlm2-500m-litert-int4",
      "qwen3-0.6b-litert-dynamic-int4",
      "qwen3-0.6b-litert-mixed-int4",
      "qwen3-0.6b-litert-int8",
      "lfm2.5-1.2b-instruct-litert-int4-gpu",
      "lfm2.5-vl-450m",
    ]);
  });

  it("pins each experimental download to exact raw bytes and an immutable upstream revision", () => {
    const pins = [
      ["qwen3-0.6b-litert-mixed-int4", 497516544, "7900eb4e7362d88c58782c6f9999bb7a129e03544aa98b8f338ea0cc5d8c22c1"],
      ["qwen3-0.6b-litert-int8", 614236160, "555579ff2f4fd13379abe69c1c3ab5200f7338bc92471557f1d6614a6e5ab0b4"],
      ["lfm2.5-1.2b-instruct-litert-int4-gpu", 736220768, "97e6a9700208f59fce2ceb993cd6c18ea77ada8c2a940f68332004f38a404671"],
      ["lfm2.5-vl-450m", 406817104, "6854cd9677a34e680070b60076793e49aeb3224de7cb4101076b261cb9bf6033"],
    ] as const;
    for (const [id, bytes, sha256] of pins) {
      const entry = SHIPPED_CATALOGUE_ENTRIES.find((item) => item.id === id);
      expect(entry?.installedBytes, id).toBe(bytes);
      expect(entry?.installedSha256, id).toBe(sha256);
      expect(entry?.revision, id).toMatch(/^[0-9a-f]{40}$/);
      expect(entry?.upstreamFile, id).toMatch(/\.litertlm$/);
      expect(entry && isInstallable(entry), id).toBe(true);
      expect(rawWeightUrlForEntry(entry!)).toBe(
        `https://huggingface.co/${entry?.pinnedRawSource?.repo}/resolve/${entry?.revision}/${entry?.upstreamFile}`,
      );
    }
  });

  it("refuses mutable or mismatched raw source metadata instead of inventing a URL", () => {
    const entry = SHIPPED_CATALOGUE_ENTRIES.find((model) => model.id === "lfm2.5-vl-450m")!;
    expect(rawWeightUrlForEntry(entry)).toContain("/be196f4fa88b2dfba8cdbbbff07b641df794f977/");
    expect(rawWeightUrlForEntry({ ...entry, revision: "main" })).toBeNull();
    expect(rawWeightUrlForEntry({ ...entry, installedSha256: "f".repeat(64) })).toBeNull();
    expect(rawWeightUrlForEntry({ ...entry, pinnedRawSource: { ...entry.pinnedRawSource!, repo: "someone/other" } })).toBeNull();
    expect(rawWeightUrlForEntry({ ...entry, distribution: { ...SHIPPED_CATALOGUE_ENTRIES[0]!.distribution! } })).toBeNull();
    expect(rawWeightUrlForEntry(SHIPPED_CATALOGUE_ENTRIES[0]!)).toBeNull();
  });
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
        "installedSha256",
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

  it("keeps fixB downloadable only through its pinned upstream weights, not the release", () => {
    const fixBHash =
      "6854cd9677a34e680070b60076793e49aeb3224de7cb4101076b261cb9bf6033";
    const vlSlot = SHIPPED_CATALOGUE_ENTRIES.find(
      (entry) => entry.id === "lfm2.5-vl-450m",
    );
    expect(vlSlot).toBeDefined();
    expect(vlSlot?.installedSha256).toBe(fixBHash);
    expect(isInstallable(vlSlot!)).toBe(true);
    expect(vlSlot?.distribution).toBeNull();
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
      bytes: 360823865,
      sha256:
        "6504b9e8972b40bd16f87b8e3bf680b2091b2f135cc23189cc0f8c86a3f1b137",
      parts: null,
    });
    expect(fiveHundred?.installedBytes).toBe(360822960);
    expect(fiveHundred?.installedSha256).toBe(
      "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0",
    );
    const qwen = SHIPPED_CATALOGUE_ENTRIES.find(
      (entry) => entry.id === "qwen3-0.6b-litert-dynamic-int4",
    );
    expect(qwen?.distribution).toMatchObject({
      repo: "sheikhti1205/FindBack-Models",
      tag: "models-2026-09-22-v1",
      asset: "qwen3-0.6b-litert-dynamic-int4.fbmodel",
      bytes: 344672709,
      sha256:
        "83109b67d59e349e7fdbd178a4742030656813edd9442c8713ca71b38e4a1efb",
      parts: null,
    });
    expect(qwen?.installedBytes).toBe(344671744);
    expect(qwen?.installedSha256).toBe(
      "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
    );
    for (const entry of SHIPPED_CATALOGUE_ENTRIES) {
      if (
        entry.id !== "smolvlm2-500m-litert-int4" &&
        entry.id !== "qwen3-0.6b-litert-dynamic-int4"
      ) {
        expect(entry.distribution ?? null, entry.id).toBeNull();
      }
    }
  });

  it("ships both v1 distributions as PUBLISHED", () => {
    const fiveHundred = SHIPPED_CATALOGUE_ENTRIES.find(
      (entry) => entry.id === "smolvlm2-500m-litert-int4",
    );
    const qwen = SHIPPED_CATALOGUE_ENTRIES.find(
      (entry) => entry.id === "qwen3-0.6b-litert-dynamic-int4",
    );
    expect(fiveHundred?.distribution?.state).toBe("PUBLISHED");
    expect(qwen?.distribution?.state).toBe("PUBLISHED");
    for (const entry of SHIPPED_CATALOGUE_ENTRIES) {
      if (entry.distribution != null) {
        expect(entry.distribution.state, entry.id).toBe("PUBLISHED");
        expect(isDistributionPublished(entry), entry.id).toBe(true);
        expect(hasUnpublishedDistribution(entry), entry.id).toBe(false);
      } else {
        expect(isDistributionPublished(entry), entry.id).toBe(false);
        expect(hasUnpublishedDistribution(entry), entry.id).toBe(false);
      }
    }
  });

  it("hands out pinned release URLs for PUBLISHED distributions only", () => {
    for (const entry of SHIPPED_CATALOGUE_ENTRIES) {
      const url = distributionUrlForEntry(entry);
      if (entry.distribution != null) {
        expect(url, entry.id).not.toBeNull();
        expect(url, entry.id).toContain(
          "https://github.com/sheikhti1205/FindBack-Models/releases/download/models-2026-09-22-v1/",
        );
      } else {
        expect(url, entry.id).toBeNull();
      }
    }
  });

  it("builds pinned release-asset URLs once PUBLISHED, without polling or mutable refs", () => {
    const published = SHIPPED_CATALOGUE_ENTRIES.map((entry) =>
      entry.distribution == null
        ? entry
        : {
            ...entry,
            distribution: { ...entry.distribution, state: "PUBLISHED" as const },
          },
    );
    const fiveHundred = published.find(
      (entry) => entry.id === "smolvlm2-500m-litert-int4",
    );
    expect(fiveHundred && isDistributionPublished(fiveHundred)).toBe(true);
    expect(fiveHundred && hasUnpublishedDistribution(fiveHundred)).toBe(false);
    expect(fiveHundred && distributionUrlForEntry(fiveHundred)).toBe(
      "https://github.com/sheikhti1205/FindBack-Models/releases/download/models-2026-09-22-v1/smolvlm2-500m-litert-int4.fbmodel",
    );
    const qwen = published.find(
      (entry) => entry.id === "qwen3-0.6b-litert-dynamic-int4",
    );
    expect(qwen && distributionUrlForEntry(qwen)).toBe(
      "https://github.com/sheikhti1205/FindBack-Models/releases/download/models-2026-09-22-v1/qwen3-0.6b-litert-dynamic-int4.fbmodel",
    );
    for (const entry of published) {
      const url = distributionUrlForEntry(entry);
      if (url != null) {
        expect(url).not.toContain("huggingface.co");
        expect(url).not.toContain("latest");
        expect(url).not.toContain("/main");
      }
    }
    expect(published.filter((entry) => entry.distribution != null)).toHaveLength(2);
  });
});
