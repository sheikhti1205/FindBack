import { describe, expect, it, vi } from "vitest";
import { labCandidateFor } from "./labCatalog";
import {
  CactusChallenger,
  CactusChannelRequiredError,
  CactusLicenseBlockedError,
  isCactusChallengerRuntime,
} from "./cactusChallenger";

describe("cactusChallenger", () => {
  it("identifies the challenger runtime without touching production ids", () => {
    expect(isCactusChallengerRuntime("cactus-lab")).toBe(true);
    expect(isCactusChallengerRuntime("litert-lm")).toBe(false);
    expect(isCactusChallengerRuntime("llama-cpp")).toBe(false);
    expect(isCactusChallengerRuntime("needle-cact")).toBe(false);
  });

  it("blocks bundle packaging and non-lab channels before any native call", async () => {
    const load = vi.fn();
    const challenger = new CactusChallenger({
      bridgeName: "fake",
      isCactusAvailable: async () => true,
      loadCactusModel: load,
      inferCactus: async function* () {},
      cancelGeneration: async () => {},
      unloadCactusModel: async () => {},
    });
    const lfm = labCandidateFor("lfm2-350m-q4_0")!;
    // bundle stays blocked by FindBack packaging policy (not an upstream ban).
    await expect(challenger.load(lfm, { channel: "bundle" })).rejects.toBeInstanceOf(
      CactusLicenseBlockedError,
    );
    // download is owner-enabled under LFM-1.0, so it clears the license gate
    // and is stopped by the lab-channel gate instead — still before native.
    await expect(challenger.load(lfm, { channel: "download" })).rejects.toBeInstanceOf(
      CactusChannelRequiredError,
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("requires a lab channel even for permissive candidates", async () => {
    const challenger = new CactusChallenger({
      bridgeName: "fake",
      isCactusAvailable: async () => true,
      loadCactusModel: async () => {},
      inferCactus: async function* () {},
      cancelGeneration: async () => {},
      unloadCactusModel: async () => {},
    });
    const baseline = labCandidateFor("qwen3-0.6b-dynamic-int4")!;
    // Every local generative descriptor is retired, so the catalogue now
    // withdraws download permission for all of them and the licence gate answers
    // first. The invariant under test is the ORDER: a licence that permits
    // still stops at the channel gate, before any native call.
    const permissive = {
      ...baseline,
      distribution: { ...baseline.distribution, downloadAllowed: true },
    };
    await expect(
      challenger.load(permissive, { channel: "download" }),
    ).rejects.toBeInstanceOf(CactusChannelRequiredError);
    // And the retired baseline itself never reaches the channel gate: there is
    // no download to permit.
    await expect(
      challenger.load(baseline, { channel: "download" }),
    ).rejects.toBeInstanceOf(CactusLicenseBlockedError);
  });

  it("loads on benchmark with an injected bridge and streams deltas", async () => {
    const challenger = new CactusChallenger({
      bridgeName: "fake-cactus",
      isCactusAvailable: async () => true,
      loadCactusModel: async () => {},
      inferCactus: async function* () {
        yield { textDelta: "hello " };
        yield { textDelta: "world" };
      },
      cancelGeneration: async () => {},
      unloadCactusModel: async () => {},
    });
    const baseline = labCandidateFor("qwen3-0.6b-dynamic-int4")!;
    const session = await challenger.load(baseline, { channel: "benchmark" });
    expect(session.runtime).toBe("cactus-lab");
    const deltas: string[] = [];
    const controller = new AbortController();
    for await (const chunk of session.generate("hi", {
      generationId: "g1",
      maxTokens: 256,
      signal: controller.signal,
    })) {
      deltas.push(chunk.textDelta);
    }
    expect(deltas.join("")).toBe("hello world");
    await session.dispose();
  });

  it("fails closed without a native bridge (never a stub stand-in)", async () => {
    const challenger = new CactusChallenger();
    const baseline = labCandidateFor("qwen3-0.6b-dynamic-int4")!;
    await expect(challenger.load(baseline, { channel: "benchmark" })).rejects.toThrow(
      /unavailable on this build/i,
    );
  });
});
