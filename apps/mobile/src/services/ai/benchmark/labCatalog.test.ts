import { describe, expect, it } from "vitest";
import { SUPPLY_CANDIDATES } from "../modelSupply";
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
  it("uses the exact canonical supply pins, publishers and companions for all Advanced candidates", () => {
    expect(LAB_CANDIDATES).toHaveLength(SUPPLY_CANDIDATES.length + 2);
    for (const d of SUPPLY_CANDIDATES) {
      expect(labCandidateFor(d.modelId)).toMatchObject({ upstreamRepo: d.upstreamRepo, fileName: d.fileName, revision: d.revision, sha256: d.sha256, pinsVerified: true });
    }
    expect(labCandidateFor("lfm2-vl-450m-int4")).toBeUndefined();
    expect(labCandidateFor("lfm2-vl-1.6b-int4")).toBeUndefined();
    expect(labCandidateFor("qwen3-vl-2b-instruct-int4")).toBeUndefined();
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
    expect(pending).toHaveLength(SUPPLY_CANDIDATES.length);
    for (const candidate of pending) {
      expect(candidate.status).toBe("integrated-pending-measurement");
      expect(candidate.maturity).toBe("lab-unmeasured");
      expect(candidate.tier).toBe("advanced");
    }
  });

  it("recommends nothing from the lab: owner picks from measured data only", () => {
    expect(recommendedLabCatalogue()).toEqual([]);
    expect(advancedCatalogue()).toHaveLength(SUPPLY_CANDIDATES.length + 2);
  });

  it("permits conditional LFM acquisition without packaging or product promotion", () => {
    for (const id of SUPPLY_CANDIDATES.filter((d) => d.license === "LFM-1.0").map((d) => d.modelId)) {
      const candidate = labCandidateFor(id);
      expect(candidate?.distribution.license).toBe("LFM-1.0");
      expect(labLicenseDecision(candidate!, "bundle").allowed).toBe(false);
      expect(labLicenseDecision(candidate!, "download").allowed).toBe(true);
      expect(labLicenseDecision(candidate!, "benchmark").allowed).toBe(true);
      expect(labLicenseDecision(candidate!, "eval").allowed).toBe(true);
      expect(isLabDownloadAllowed(candidate!, "download")).toBe(true);
    }
  });

  it("blocks pending-pin downloads for permissive candidates until verified", () => {
    for (const id of ["qwen3-1.7b-dynamic-int4", "granite-3.3-2b-instruct-q4_0", "qwen3-vl-2b-instruct-q4_k_m"]) {
      const candidate = { ...labCandidateFor(id)!, pinsVerified: false };
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
    expect(vision).toHaveLength(SUPPLY_CANDIDATES.filter((d) => d.capabilities.includes("vision")).length + 1);
    for (const candidate of vision) {
      expect(candidate.capabilities).toContain("vision");
    }
    expect(getTextCapableLabModels()).toHaveLength(SUPPLY_CANDIDATES.filter((d) => d.capabilities.includes("text")).length + 1);
    expect(getBenchmarkCapableLabModels()).toHaveLength(SUPPLY_CANDIDATES.length + 2);
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
