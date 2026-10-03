import { describe, expect, it } from "vitest";
import { MODEL_PROFILES, profileFor, profilesForOp } from "./modelProfiles";

const CORPUS_MODELS = [
  "SmolVLM2-500M-text",
  "Qwen3-0.6B-dynamic-int4",
  "LFM2.5-1.2B-Q4_0",
  "SmolVLM2-500M-vision",
  "LFM2.5-VL-450M-int4-stock",
  "LFM2.5-VL-450M-int4-fixB",
  "Needle3-cact-l20",
];

describe("model profiles", () => {
  it("encodes every authorized lab model and none is deleted", () => {
    expect(MODEL_PROFILES).toHaveLength(7);
    for (const label of CORPUS_MODELS) {
      expect(MODEL_PROFILES.some((profile) => profile.corpusLabel === label)).toBe(true);
    }
  });

  it("pins needle3 challenger to rev c7c415a3 with Apache-2.0 terms", () => {
    const needle = profileFor("needle3-cact-l20");
    expect(needle?.revision).toBe("c7c415a3d1b3d929014bc6e866d51ebb971f7089");
    expect(needle?.modelSha256).toBe(
      "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38",
    );
    expect(needle?.runtime).toBe("needle-cact");
    expect(needle?.format).toBe("cact");
    expect(needle?.license).toBeUndefined();
    expect(needle?.catalogOnly).toBeUndefined();
    expect(needle?.maturity).toBe("experimental");
  });

  it("pins Qwen3-0.6B INT4 to rev a3c5d805 with the thought envelope", () => {
    const qwen = profileFor("qwen3-0.6b-dynamic-int4");
    expect(qwen?.revision).toBe("a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76");
    expect(qwen?.thoughtEnvelope).toEqual({ openMarker: "[thought]", closeMarker: "[/thought]" });
    expect(qwen?.structuredOutputStrategy).toBe("thought-envelope-then-prose");
    expect(qwen?.roles).toContain("answer-help");
  });

  it("declares the thought envelope on Qwen only (no global strip)", () => {
    for (const profile of MODEL_PROFILES) {
      if (profile.id === "qwen3-0.6b-dynamic-int4") continue;
      expect(profile.thoughtEnvelope).toBeUndefined();
    }
  });

  it("keeps SmolVLM2-500M text off Help/text roles", () => {
    const smol = profileFor("smolvlm2-500m-text");
    expect(smol?.roles).toEqual(["classify-intent"]);
    expect(smol?.supportsGeneral).toBe(false);
    expect(smol?.roleNotes).toContain("18/31");
  });

  it("marks LFM2.5-1.2B experimental and off structured extraction", () => {
    const lfm = profileFor("lfm2.5-1.2b-q4_0");
    expect(lfm?.maturity).toBe("experimental");
    expect(lfm?.roles).toEqual(["answer-help"]);
  });

  it("keeps LFM-VL arms eval-only with vision roles", () => {
    expect(profileFor("lfm2.5-vl-450m-fixb")?.maturity).toBe("eval-only");
    expect(profileFor("lfm2.5-vl-450m-stock")?.maturity).toBe("eval-only");
    expect(profilesForOp("analyze-image")).toHaveLength(1);
    expect(profilesForOp("analyze-image", true)).toHaveLength(3);
    expect(profilesForOp("classify-intent").map((profile) => profile.id)).toContain(
      "smolvlm2-500m-text",
    );
  });

  it("uses evidence-backed sampler caps and one retry, no timeout numbers", () => {
    for (const profile of MODEL_PROFILES) {
      expect(profile.defaultTemperature).toBe(0.0);
      expect(profile.maxOutputTokensText).toBe(256);
      expect(profile.retryLimit).toBe(1);
      expect(profile.stopSequences).toEqual([]);
      expect(profile.loopPolicy).toEqual({ owner: "task-22", errorClass: "LOOP_DETECTED" });
      expect("timeoutMs" in profile).toBe(false);
      expect("timeoutBudgetMs" in profile).toBe(false);
    }
    for (const id of ["smolvlm2-500M-vision", "lfm2.5-vl-450m-stock", "lfm2.5-vl-450m-fixb"]) {
      expect(profileFor(id)?.maxOutputTokensVision).toBe(512);
    }
  });
});
