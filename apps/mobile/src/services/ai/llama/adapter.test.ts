/**
 * llama.cpp challenger adapter tests (E1): license-first ordering,
 * lab-channel enforcement, and the real session path over a fake bridge.
 * No JNI, no weights — the bridge is faked at the TS seam.
 */
import { describe, expect, it } from "vitest";
import {
  LabChannelRequiredError,
  LfmLicenseBlockedError,
  LlamaCppChallenger,
  type LlamaNativeBridge,
} from "./adapter";
import { profileFor } from "../modelProfiles";

function fakeBridge(chunks: string[] = ["hello", " world"]): LlamaNativeBridge & {
  loads: { modelId: string }[];
  unloads: number;
} {
  const loads: { modelId: string }[] = [];
  let unloads = 0;
  return {
    loads,
    get unloads() {
      return unloads;
    },
    bridgeName: "test-llama-stub",
    isLlamaAvailable: async () => true,
    loadLlamaModel: async (args: { modelId: string }) => {
      loads.push({ modelId: args.modelId });
    },
    inferLlama: async function* (args: { prompt: string }) {
      if (args.prompt === "") throw new Error("empty prompt");
      for (const chunk of chunks) yield { textDelta: chunk };
    },
    cancelGeneration: async () => {},
    unloadLlamaModel: async () => {
      unloads += 1;
    },
  };
}

describe("llama.cpp challenger adapter", () => {
  it("blocks LFM arms on production channels before any native call", async () => {
    const bridge = fakeBridge();
    const challenger = new LlamaCppChallenger(bridge);
    const lfm = profileFor("lfm2.5-1.2b-q4_0");
    await expect(challenger.load(lfm!, { channel: "bundle" })).rejects.toBeInstanceOf(
      LfmLicenseBlockedError,
    );
    await expect(challenger.load(lfm!, { channel: "download" })).rejects.toBeInstanceOf(
      LfmLicenseBlockedError,
    );
    expect(bridge.loads).toEqual([]);
  });

  it("requires a lab channel even when the license passes", async () => {
    const bridge = fakeBridge();
    const challenger = new LlamaCppChallenger(bridge);
    const qwen = profileFor("qwen3-0.6b-dynamic-int4");
    // Wrong runtime first: the challenger only serves llama-cpp profiles.
    await expect(challenger.load(qwen!, { channel: "benchmark" })).rejects.toThrow(
      /expected llama-cpp/,
    );
    expect(bridge.loads).toEqual([]);
  });

  it("rejects production channels for llama-cpp profiles", async () => {
    const bridge = fakeBridge();
    const challenger = new LlamaCppChallenger(bridge);
    const lfm = profileFor("lfm2.5-1.2b-q4_0");
    // License passes on eval, but bundle/download are not lab channels.
    // (bundle/download are already license-blocked for LFM; use a
    // permissive stand-in profile shape for the channel gate.)
    const permissiveGguf = { ...lfm!, license: undefined, catalogOnly: undefined };
    await expect(
      challenger.load(permissiveGguf, { channel: "bundle" }),
    ).rejects.toBeInstanceOf(LabChannelRequiredError);
    await expect(
      challenger.load(permissiveGguf, { channel: "download" }),
    ).rejects.toBeInstanceOf(LabChannelRequiredError);
    expect(bridge.loads).toEqual([]);
  });

  it("loads a real session on lab channels and streams generations", async () => {
    const bridge = fakeBridge(["a ", "b"]);
    const challenger = new LlamaCppChallenger(bridge);
    const lfm = profileFor("lfm2.5-1.2b-q4_0");
    const session = await challenger.load(lfm!, { channel: "eval" });
    expect(session.profileId).toBe("lfm2.5-1.2b-q4_0");
    expect(session.runtime).toBe("llama-cpp");
    expect(bridge.loads).toEqual([{ modelId: "lfm2.5-1.2b-q4_0" }]);
    const controller = new AbortController();
    const deltas: string[] = [];
    for await (const chunk of session.generate("hi", {
      generationId: "g1",
      maxTokens: 16,
      signal: controller.signal,
    })) {
      deltas.push(chunk.textDelta);
    }
    expect(deltas.join("")).toBe("a b");
    await session.dispose();
    expect(bridge.unloads).toBe(1);
  });

  it("stops without a bridge instead of inventing a session", async () => {
    const challenger = new LlamaCppChallenger();
    const lfm = profileFor("lfm2.5-1.2b-q4_0");
    await expect(challenger.load(lfm!, { channel: "benchmark" })).rejects.toThrow(
      /unavailable on this build/,
    );
  });
});
