import { describe, expect, it, vi } from "vitest";
import { activateModel, isRuntimeReadyForEntry } from "./modelActivation";
import type { ModelCatalogueEntry } from "./catalogueTypes";
import type { VlmModelInfo } from "../vlmPlugin";

function entry(overrides: Partial<ModelCatalogueEntry> = {}): ModelCatalogueEntry {
  return {
    id: "smolvlm2-500m-litert-int4",
    displayName: "SmolVLM2 500M (LiteRT, int4)",
    category: "vision",
    role: "report-from-photo",
    runtime: "litert-lm",
    format: "litertlm",
    revision: "dad030b6e56756201d670cfb4d042736a2ce3a5c",
    license: "apache-2.0",
    downloadBytes: 360822960,
    installedBytes: 360822960,
    sha256: "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0",
    minFreeRamMb: 1536,
    recommendedFreeRamMb: 2560,
    ramRequirementSource: "CONSERVATIVE_ESTIMATE",
    verificationStatus: "VERIFIED",
    description: "Tiny vision-language model for on-device report-from-photo.",
    supportedCapabilities: ["report-from-photo"],
    upstreamRepo: "litert-community/SmolVLM2-500M",
    provenance: [{ kind: "REPO_EVIDENCE", ref: "x", note: "test" }],
    ...overrides,
  };
}

function state(id: "smolvlm2-500m", state: VlmModelInfo["state"]): VlmModelInfo {
  return { id, state };
}

function fakeBridge(states: VlmModelInfo[], order: string[]) {
  return {
    cancelInference: vi.fn(async () => {
      order.push("cancel");
    }),
    release: vi.fn(async () => {
      order.push("release");
    }),
    getModelStates: vi.fn(async () => states),
  };
}

describe("isRuntimeReadyForEntry", () => {
  it("accepts only the genuine init proof", () => {
    expect(isRuntimeReadyForEntry([state("smolvlm2-500m", "READY_GPU")], "smolvlm2-500m")).toBe(true);
    expect(isRuntimeReadyForEntry([state("smolvlm2-500m", "INSTALLED_UNVERIFIED")], "smolvlm2-500m")).toBe(false);
    expect(isRuntimeReadyForEntry([state("smolvlm2-500m", "GPU_UNAVAILABLE")], "smolvlm2-500m")).toBe(false);
    expect(isRuntimeReadyForEntry([], "smolvlm2-500m")).toBe(false);
  });
});

describe("activateModel", () => {
  it("succeeds only after the READY_GPU proof, preserving cancel → release order", async () => {
    const order: string[] = [];
    const bridge = fakeBridge([state("smolvlm2-500m", "READY_GPU")], order);
    const result = await activateModel(bridge, entry(), {
      currentResidentId: null,
      availableFreeRamMb: null,
      advancedConfirmed: false,
      runtimeCapability: "RUNTIME_AVAILABLE",
    });
    expect(result).toEqual({ ok: true, alreadyActive: false });
    expect(order).toEqual(["cancel", "release"]);
  });

  it("fails when the runtime is installed but never initialized", async () => {
    const order: string[] = [];
    const bridge = fakeBridge([state("smolvlm2-500m", "INSTALLED_UNVERIFIED")], order);
    const result = await activateModel(bridge, entry(), {
      currentResidentId: null,
      availableFreeRamMb: null,
      advancedConfirmed: false,
      runtimeCapability: "RUNTIME_AVAILABLE",
    });
    expect(result.ok).toBe(false);
    expect(order).toEqual(["cancel", "release"]);
  });

  it("never touches the bridge for unwired entries", async () => {
    const order: string[] = [];
    const bridge = fakeBridge([], order);
    const result = await activateModel(
      bridge,
      entry({
        id: "qwen3-0.6b-litert-dynamic-int4",
        category: "text",
        role: "chat-text",
        verificationStatus: "SUPPORTED_UNVERIFIED",
      }),
      { currentResidentId: null, availableFreeRamMb: null, advancedConfirmed: false, runtimeCapability: "RUNTIME_UNAVAILABLE" },
    );
    expect(result.ok).toBe(false);
    expect(bridge.cancelInference).not.toHaveBeenCalled();
    expect(bridge.release).not.toHaveBeenCalled();
  });

  it("reports already-active without touching the bridge", async () => {
    const order: string[] = [];
    const bridge = fakeBridge([state("smolvlm2-500m", "READY_GPU")], order);
    const result = await activateModel(bridge, entry(), {
      currentResidentId: "smolvlm2-500m-litert-int4",
      availableFreeRamMb: null,
      advancedConfirmed: false,
      runtimeCapability: "RUNTIME_AVAILABLE",
    });
    expect(result).toEqual({ ok: true, alreadyActive: true });
    expect(bridge.cancelInference).not.toHaveBeenCalled();
    expect(bridge.release).not.toHaveBeenCalled();
  });

  it("aborts on a post-release memory drop below the entry minimum", async () => {
    const order: string[] = [];
    const bridge = fakeBridge([state("smolvlm2-500m", "READY_GPU")], order);
    const result = await activateModel(bridge, entry(), {
      currentResidentId: null,
      availableFreeRamMb: 512,
      advancedConfirmed: true,
      runtimeCapability: "RUNTIME_AVAILABLE",
    });
    expect(result.ok).toBe(false);
    expect(order).toEqual(["cancel", "release"]);
  });
});
