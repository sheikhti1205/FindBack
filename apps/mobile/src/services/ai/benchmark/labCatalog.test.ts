import { describe, expect, it } from "vitest";
import {
  advancedCatalogue,
  getBenchmarkCapableLabModels,
  getChatCapableLabModels,
  getTextCapableLabModels,
  getVisionCapableLabModels,
  isLabDownloadAllowed,
  labCandidateFor,
  labLicenseDecision,
  LAB_CANDIDATES,
  recommendedLabCatalogue,
} from "./labCatalog";

describe("labCatalog", () => {
  it("covers all ten candidates: 6 text + 4 vision", () => {
    expect(LAB_CANDIDATES).toHaveLength(10);
    expect(LAB_CANDIDATES.filter((c) => c.modality === "text")).toHaveLength(6);
    expect(LAB_CANDIDATES.filter((c) => c.modality === "vision")).toHaveLength(4);
  });

  it("keeps baselines pinned and every new model pending-measurement", () => {
    const baselines = LAB_CANDIDATES.filter((c) => c.baseline);
    expect(baselines.map((c) => c.modelId).sort()).toEqual(
      ["qwen3-0.6b-dynamic-int4", "smolvlm2-500M-vision"].sort(),
    );
    for (const baseline of baselines) {
      expect(baseline.pinsVerified).toBe(true);
      expect(baseline.status).toBe("integrated-baseline");
    }
    const pending = LAB_CANDIDATES.filter((c) => !c.baseline);
    expect(pending).toHaveLength(8);
    for (const candidate of pending) {
      expect(candidate.status).toBe("integrated-pending-measurement");
      expect(candidate.maturity).toBe("lab-unmeasured");
      expect(candidate.tier).toBe("advanced");
    }
  });

  it("recommends nothing from the lab: owner picks from measured data only", () => {
    expect(recommendedLabCatalogue()).toEqual([]);
    expect(advancedCatalogue()).toHaveLength(10);
  });

  it("blocks LFM arms on bundle/download and allows benchmark/eval", () => {
    for (const id of ["lfm2-350m-q4_0", "lfm2-700m-q4_0", "lfm2-1.2b-q4_0", "lfm2-vl-450m-int4", "lfm2-vl-1.6b-int4"]) {
      const candidate = labCandidateFor(id);
      expect(candidate?.distribution.license).toBe("LFM-1.0");
      expect(labLicenseDecision(candidate!, "bundle").allowed).toBe(false);
      expect(labLicenseDecision(candidate!, "download").allowed).toBe(false);
      expect(labLicenseDecision(candidate!, "benchmark").allowed).toBe(true);
      expect(labLicenseDecision(candidate!, "eval").allowed).toBe(true);
      expect(isLabDownloadAllowed(candidate!, "download")).toBe(false);
    }
  });

  it("blocks pending-pin downloads for permissive candidates until verified", () => {
    for (const id of ["qwen3-1.7b-dynamic-int4", "granite-3.3-2b-instruct-q4_0", "qwen3-vl-2b-instruct-int4"]) {
      const candidate = labCandidateFor(id)!;
      expect(candidate.pinsVerified).toBe(false);
      expect(labLicenseDecision(candidate, "download").allowed).toBe(false);
      expect(labLicenseDecision(candidate, "benchmark").allowed).toBe(true);
      expect(isLabDownloadAllowed(candidate)).toBe(false);
    }
  });

  it("selects chat/vision by capability and role, never by hardcoded id", () => {
    const chat = getChatCapableLabModels();
    expect(chat.length).toBeGreaterThan(0);
    for (const candidate of chat) {
      expect(candidate.capabilities).toContain("text");
    }
    // A synthetic future candidate with the same shape appears automatically.
    const synthetic = {
      ...labCandidateFor("qwen3-0.6b-dynamic-int4")!,
      modelId: "synthetic-future-chat",
    };
    expect(getChatCapableLabModels([...LAB_CANDIDATES, synthetic]).map((c) => c.modelId)).toContain(
      "synthetic-future-chat",
    );

    const vision = getVisionCapableLabModels();
    expect(vision).toHaveLength(4);
    for (const candidate of vision) {
      expect(candidate.capabilities).toContain("vision");
    }
    expect(getTextCapableLabModels()).toHaveLength(6);
    expect(getBenchmarkCapableLabModels()).toHaveLength(10);
  });

  it("records runtime/format and RAM estimates for every candidate", () => {
    for (const candidate of LAB_CANDIDATES) {
      expect(["litert-lm", "llama-cpp", "needle-cact", "cactus-lab"]).toContain(candidate.runtime);
      expect(["litertlm", "gguf", "cact"]).toContain(candidate.format);
      expect(candidate.minRamMb).toBeGreaterThan(0);
      expect(candidate.recommendedRamMb).toBeGreaterThanOrEqual(candidate.minRamMb);
      expect(candidate.upstreamRepo).toMatch(/\//);
      expect(candidate.fileName.trim()).not.toBe("");
    }
  });
});
