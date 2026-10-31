import { describe, expect, it } from "vitest";
import { MODEL_PROFILES, profileFor } from "./modelProfiles";
import { NEEDLE_MODEL_ID } from "./needle/embedder";

describe("retained local tool profile", () => {
  it("ships only Needle execution metadata, not retired evaluation profiles", () => {
    expect(MODEL_PROFILES.map((profile) => profile.id)).toEqual([NEEDLE_MODEL_ID]);
    for (const id of ["qwen3-0.6b-dynamic-int4", "smolvlm2-500M-vision", "lfm2.5-1.2b-q4_0"]) {
      expect(profileFor(id)).toBeUndefined();
    }
  });

  it("keeps the exact retained Needle artifact pin and bounded tool output", () => {
    const needle = profileFor(NEEDLE_MODEL_ID)!;
    expect(needle.revision).toBe("c7c415a3d1b3d929014bc6e866d51ebb971f7089");
    expect(needle.modelSha256).toBe("c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38");
    expect(needle.runtime).toBe("needle-cact");
    expect(needle.format).toBe("cact");
    expect(needle.supportsVision).toBe(false);
    expect(needle.supportsGeneral).toBe(false);
    expect(needle.structuredOutputStrategy).toBe("single-json-object");
    expect(needle.thoughtEnvelope).toBeUndefined();
    expect(needle.defaultTemperature).toBe(0);
    expect(needle.maxOutputTokensText).toBe(256);
    expect(needle.retryLimit).toBe(1);
    expect("timeoutMs" in needle).toBe(false);
  });
});
