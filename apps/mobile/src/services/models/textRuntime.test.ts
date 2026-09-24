import { describe, expect, it, vi } from "vitest";
import {
  QWEN_TEXT_BRIDGE_MODEL_ID,
  QWEN_TEXT_ENTRY_ID,
  TEXT_NARROW_OPS,
  activateTextModel,
  createBridgeTextEngine,
  isNarrowTextProfile,
  isTextRuntimePresent,
  qwenTextProfile,
  runtimeCapabilityForTextEntry,
  toGenerateTextRequest,
  verifyQwenCataloguePin,
  type GenerateTextRequest,
  type TextGenerationBridge,
} from "./textRuntime";
import { SHIPPED_CATALOGUE_ENTRIES } from "./shippedCatalogue";
import type { ModelCatalogueEntry } from "./catalogueTypes";

function qwenEntry(
  overrides: Partial<ModelCatalogueEntry> = {},
): ModelCatalogueEntry {
  return {
    id: QWEN_TEXT_ENTRY_ID,
    displayName: "Qwen3 0.6B (LiteRT, dynamic int4)",
    category: "text",
    role: "chat-text",
    runtime: "litert-lm",
    format: "litertlm",
    revision: "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76",
    license: "apache-2.0",
    downloadBytes: 344672709,
    installedBytes: 344671744,
    sha256:
      "83109b67d59e349e7fdbd178a4742030656813edd9442c8713ca71b38e4a1efb",
    installedSha256:
      "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
    minFreeRamMb: 1280,
    recommendedFreeRamMb: 2560,
    ramRequirementSource: "CONSERVATIVE_ESTIMATE",
    verificationStatus: "SUPPORTED_UNVERIFIED",
    description: "Qualified on-device text entry.",
    supportedCapabilities: ["text-generation"],
    upstreamRepo: "litert-community/Qwen3-0.6B",
    upstreamFile: "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
    provenance: [{ kind: "VENDOR_MODEL_CARD", ref: "x", note: "test" }],
    ...overrides,
  };
}

function fakeBridge(order: string[], text = "hello"): TextGenerationBridge & {
  requests: GenerateTextRequest[];
} {
  const requests: GenerateTextRequest[] = [];
  return {
    requests,
    generateText: vi.fn(async (request: GenerateTextRequest) => {
      requests.push(request);
      return { text, modelId: request.modelId };
    }),
    cancelInference: vi.fn(async () => {
      order.push("cancel");
    }),
    release: vi.fn(async () => {
      order.push("release");
    }),
  };
}

describe("qualified pin", () => {
  it("matches the shipped catalogue entry exactly", () => {
    const shipped = SHIPPED_CATALOGUE_ENTRIES.find(
      (entry) => entry.id === QWEN_TEXT_ENTRY_ID,
    );
    expect(shipped).toBeDefined();
    expect(verifyQwenCataloguePin(shipped as ModelCatalogueEntry)).toEqual({
      ok: true,
    });
  });

  it("rejects drifted revision, installed bytes, and installed hash", () => {
    expect(
      verifyQwenCataloguePin(qwenEntry({ revision: "deadbeef" })),
    ).toMatchObject({ ok: false });
    expect(verifyQwenCataloguePin(qwenEntry({ installedBytes: 1 }))).toMatchObject({
      ok: false,
    });
    expect(verifyQwenCataloguePin(qwenEntry({ installedSha256: "00" }))).toMatchObject({
      ok: false,
    });
  });

  it("ignores distribution-package rotation without re-qualification", () => {
    expect(
      verifyQwenCataloguePin(
        qwenEntry({ downloadBytes: 344672714, sha256: "ff" }),
      ),
    ).toEqual({ ok: true });
  });

  it("refuses entries outside the qualified pin", () => {
    expect(
      verifyQwenCataloguePin(qwenEntry({ id: "qwen3-0.6b-litert-int8" })),
    ).toMatchObject({ ok: false });
    expect(
      verifyQwenCataloguePin(qwenEntry({ id: "smolvlm2-500m-litert-int4" })),
    ).toMatchObject({ ok: false });
  });
});

describe("isTextRuntimePresent", () => {
  it("detects the real bridge method only", () => {
    expect(isTextRuntimePresent(fakeBridge([]))).toBe(true);
    expect(isTextRuntimePresent({})).toBe(false);
    expect(isTextRuntimePresent(null)).toBe(false);
    expect(isTextRuntimePresent({ generateText: "yes" })).toBe(false);
  });
});

describe("runtimeCapabilityForTextEntry", () => {
  it("is available only with pin plus present bridge", () => {
    expect(runtimeCapabilityForTextEntry(qwenEntry(), true)).toBe(
      "RUNTIME_AVAILABLE",
    );
    expect(runtimeCapabilityForTextEntry(qwenEntry(), false)).toBe(
      "RUNTIME_UNAVAILABLE",
    );
  });

  it("keeps unpinned and experimental entries unrunnable", () => {
    expect(
      runtimeCapabilityForTextEntry(
        qwenEntry({ id: "qwen3-0.6b-litert-mixed-int4" }),
        true,
      ),
    ).toBe("RUNTIME_UNAVAILABLE");
    expect(
      runtimeCapabilityForTextEntry(
        qwenEntry({ verificationStatus: "EXPERIMENTAL" }),
        true,
      ),
    ).toBe("RUNTIME_UNAVAILABLE");
    expect(
      runtimeCapabilityForTextEntry(qwenEntry({ catalogOnly: true }), true),
    ).toBe("RUNTIME_UNAVAILABLE");
  });
});

describe("toGenerateTextRequest", () => {
  it("carries the explicit model id", () => {
    expect(
      toGenerateTextRequest(QWEN_TEXT_BRIDGE_MODEL_ID, "hi", {
        maxOutputTokens: 256,
        temperature: 0,
      }),
    ).toEqual({
      modelId: "qwen3-0.6b",
      prompt: "hi",
      maxOutputTokens: 256,
      temperature: 0,
    });
  });
});

describe("createBridgeTextEngine", () => {
  it("sends text with the initialized model id and releases", async () => {
    const order: string[] = [];
    const bridge = fakeBridge(order, "answer");
    const engine = createBridgeTextEngine(bridge);
    expect(engine.supportsStreaming).toBe(false);
    await engine.initialize(QWEN_TEXT_BRIDGE_MODEL_ID);
    const conversation = engine.startConversation();
    await expect(
      conversation.sendText("hi", { maxOutputTokens: 64, temperature: 0 }),
    ).resolves.toBe("answer");
    expect(bridge.requests).toEqual([
      {
        modelId: "qwen3-0.6b",
        prompt: "hi",
        maxOutputTokens: 64,
        temperature: 0,
      },
    ]);
    await conversation.cancel();
    await engine.release();
    expect(order).toEqual(["cancel", "release"]);
  });

  it("refuses sends before initialize and after release", async () => {
    const engine = createBridgeTextEngine(fakeBridge([]));
    expect(() => engine.startConversation()).toThrow(/initialize/);
    await engine.initialize(QWEN_TEXT_BRIDGE_MODEL_ID);
    await engine.release();
    expect(() => engine.startConversation()).toThrow(/initialize/);
  });
});

describe("qwenTextProfile", () => {
  it("resolves to the narrow text profile", () => {
    const profile = qwenTextProfile();
    expect(profile?.id).toBe("qwen3-0.6b-dynamic-int4");
    expect(isNarrowTextProfile(profile as NonNullable<typeof profile>)).toBe(
      true,
    );
    expect(TEXT_NARROW_OPS).not.toContain("analyze-image");
  });
});

describe("activateTextModel", () => {
  const baseOptions = {
    currentResidentId: null as string | null,
    availableFreeRamMb: 4096 as number | null,
    advancedConfirmed: false,
    textRuntimePresent: true,
    runtimeReady: true,
  };

  it("activates only with the ready proof, preserving cancel → release order", async () => {
    const order: string[] = [];
    const result = await activateTextModel(fakeBridge(order), qwenEntry(), {
      ...baseOptions,
      currentResidentId: "smolvlm2-500m-litert-int4",
    });
    expect(result).toEqual({ ok: true, alreadyActive: false });
    expect(order).toEqual(["cancel", "release"]);
  });

  it("reports already active without touching the bridge", async () => {
    const order: string[] = [];
    const bridge = fakeBridge(order);
    const result = await activateTextModel(bridge, qwenEntry(), {
      ...baseOptions,
      currentResidentId: QWEN_TEXT_ENTRY_ID,
    });
    expect(result).toEqual({ ok: true, alreadyActive: true });
    expect(order).toEqual([]);
    expect(bridge.cancelInference).not.toHaveBeenCalled();
  });

  it("blocks unwired entries and absent runtimes", async () => {
    const order: string[] = [];
    const bridge = fakeBridge(order);
    await expect(
      activateTextModel(
        bridge,
        qwenEntry({ id: "qwen3-0.6b-litert-int8" }),
        baseOptions,
      ),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      activateTextModel(bridge, qwenEntry(), {
        ...baseOptions,
        textRuntimePresent: false,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(order).toEqual([]);
  });

  it("aborts on memory drop and on missing ready proof", async () => {
    const dropped: string[] = [];
    await expect(
      activateTextModel(fakeBridge(dropped), qwenEntry(), {
        ...baseOptions,
        availableFreeRamMb: 512,
        advancedConfirmed: true,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(dropped).toEqual(["cancel", "release"]);
    const unready: string[] = [];
    await expect(
      activateTextModel(fakeBridge(unready), qwenEntry(), {
        ...baseOptions,
        runtimeReady: false,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(unready).toEqual(["cancel", "release"]);
  });
});
