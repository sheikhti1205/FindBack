import { describe, expect, it } from "vitest";
import { profileFor } from "../modelProfiles";
import { LlamaCppChallenger, LfmLicenseBlockedError } from "./adapter";
import { enforce } from "./licenseGate";
import { isPromotable, isRoutable, LAB_ONLY_RUNTIMES, promotionDecision } from "./promotionPolicy";

describe("LFM license gate", () => {
  it("blocks the LFM text arm for bundle and download distribution", () => {
    const lfm = profileFor("lfm2.5-1.2b-q4_0");
    expect(lfm?.license).toBe("LFM-1.0");
    expect(lfm?.catalogOnly).toBe(true);
    expect(enforce(lfm!, "bundle").allowed).toBe(false);
    expect(enforce(lfm!, "download").allowed).toBe(false);
    expect(enforce(lfm!).allowed).toBe(false);
  });

  it("blocks the LFM-VL arms for bundle distribution", () => {
    for (const id of ["lfm2.5-vl-450m-stock", "lfm2.5-vl-450m-fixb"]) {
      const arm = profileFor(id);
      expect(arm?.license).toBe("LFM-1.0");
      expect(arm?.catalogOnly).toBe(true);
      expect(enforce(arm!, "bundle").allowed).toBe(false);
      expect(enforce(arm!, "download").allowed).toBe(false);
    }
  });

  it("allows LFM arms for benchmark and eval channels", () => {
    const lfm = profileFor("lfm2.5-1.2b-q4_0");
    expect(enforce(lfm!, "benchmark").allowed).toBe(true);
    expect(enforce(lfm!, "eval").allowed).toBe(true);
  });

  it("leaves permissive models unaffected on every channel", () => {
    for (const id of ["smolvlm2-500m-text", "qwen3-0.6b-dynamic-int4", "smolvlm2-500M-vision"]) {
      const profile = profileFor(id);
      for (const channel of ["bundle", "download", "benchmark", "eval"] as const) {
        expect(enforce(profile!, channel).allowed).toBe(true);
      }
    }
  });

  it("refuses adapter load before any native runtime on blocked channels", async () => {
    const challenger = new LlamaCppChallenger();
    const lfm = profileFor("lfm2.5-1.2b-q4_0");
    await expect(challenger.load(lfm!, { channel: "bundle" })).rejects.toBeInstanceOf(
      LfmLicenseBlockedError,
    );
    await expect(challenger.load(lfm!, { channel: "download" })).rejects.toBeInstanceOf(
      LfmLicenseBlockedError,
    );
  });
});

describe("promotion policy", () => {
  it("marks MLC-LLM, ExecuTorch, and Neuron lab-only: never promotable, never routable", () => {
    expect(LAB_ONLY_RUNTIMES).toEqual(["mlc-llm", "executorch", "neuron"]);
    for (const runtime of LAB_ONLY_RUNTIMES) {
      const decision = promotionDecision(runtime);
      expect(decision.promotable).toBe(false);
      expect(decision.routable).toBe(false);
      expect(isPromotable(runtime)).toBe(false);
      expect(isRoutable(runtime)).toBe(false);
    }
  });

  it("does not lab-gate production runtimes", () => {
    for (const runtime of ["litert-lm", "llama-cpp"]) {
      expect(isPromotable(runtime)).toBe(true);
      expect(isRoutable(runtime)).toBe(true);
    }
  });
});
