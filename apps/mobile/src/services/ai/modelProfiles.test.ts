import { describe, expect, it } from "vitest";
import { MODEL_PROFILES, profileFor, profilesForOp } from "./modelProfiles";

const CORPUS_MODELS = [
  "SmolVLM2-500M-text",
  "Qwen3-0.6B-dynamic-int4",
  "LFM2.5-1.2B-Q4_0",
  "SmolVLM2-500M-vision",
  "LFM2.5-VL-450M-int4-stock",
  "LFM2.5-VL-450M-int4-fixB",
];

describe("model profiles", () => {
  it("encodes every authorized lab model and none is deleted", () => {
    expect(MODEL_PROFILES).toHaveLength(6);
    for (const label of CORPUS_MODELS) {
      expect(MODEL_PROFILES.some((profile) => profile.corpusLabel === label)).toBe(true);
    }
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
