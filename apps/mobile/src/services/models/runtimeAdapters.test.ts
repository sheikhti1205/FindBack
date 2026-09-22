import { describe, expect, it } from "vitest";
import {
  buildRuntimeRequest,
  routeEntryToAdapter,
  toLegacyAnalyzeRequest,
} from "./runtimeAdapters";
import type { ModelCatalogueEntry } from "./catalogueTypes";

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

describe("routeEntryToAdapter", () => {
  it("routes the wired vision entry to vlm-image with its bridge id", () => {
    const route = routeEntryToAdapter(entry());
    expect(route).toEqual({ ok: true, adapter: "vlm-image", bridgeId: "smolvlm2-500m" });
  });

  it("never routes text entries through the image runtime", () => {
    const route = routeEntryToAdapter(
      entry({
        id: "qwen3-0.6b-litert-dynamic-int4",
        displayName: "Qwen3 0.6B (LiteRT, dynamic int4)",
        category: "text",
        role: "chat-text",
        revision: "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76",
        downloadBytes: 344671744,
        installedBytes: 344671744,
        minFreeRamMb: 1280,
        recommendedFreeRamMb: 2560,
        verificationStatus: "SUPPORTED_UNVERIFIED",
      }),
    );
    expect(route.ok).toBe(false);
  });

  it("blocks catalogue-only entries", () => {
    const route = routeEntryToAdapter(entry({ id: "gemma-3n-e2b-it-litert-int4", catalogOnly: true }));
    expect(route.ok).toBe(false);
  });

  it("blocks experimental eval-only entries", () => {
    const route = routeEntryToAdapter(
      entry({ id: "lfm2.5-vl-450m", verificationStatus: "EXPERIMENTAL" }),
    );
    expect(route.ok).toBe(false);
  });

  it("rejects a role mismatch even for a mapped id", () => {
    const route = routeEntryToAdapter(entry({ role: "chat-text" }));
    expect(route.ok).toBe(false);
  });
});

describe("buildRuntimeRequest", () => {
  it("carries model identity, role, input, and options together", () => {
    const target = entry();
    const route = routeEntryToAdapter(target);
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    const request = buildRuntimeRequest(
      target,
      route,
      { kind: "image", imageUri: "content://photo", instruction: "describe" },
      { maxOutputTokens: 224, temperature: 0.1 },
    );
    expect(request.entryId).toBe("smolvlm2-500m-litert-int4");
    expect(request.bridgeId).toBe("smolvlm2-500m");
    expect(request.adapter).toBe("vlm-image");
    expect(request.role).toBe("report-from-photo");
    expect(request.input).toEqual({ kind: "image", imageUri: "content://photo", instruction: "describe" });
  });

  it("maps image requests onto the legacy analyze shape and refuses text input", () => {
    const target = entry();
    const route = routeEntryToAdapter(target);
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    const request = buildRuntimeRequest(
      target,
      route,
      { kind: "image", imageUri: "content://photo", instruction: "describe" },
      { maxOutputTokens: 224, temperature: 0.1 },
    );
    expect(toLegacyAnalyzeRequest(request, "QUALITY")).toEqual({
      mode: "QUALITY",
      imageUri: "content://photo",
      instruction: "describe",
      maxOutputTokens: 224,
      temperature: 0.1,
    });
    const textRequest = buildRuntimeRequest(
      target,
      route,
      { kind: "text", prompt: "hello" },
      { maxOutputTokens: 64, temperature: 0.2 },
    );
    expect(() => toLegacyAnalyzeRequest(textRequest, "QUALITY")).toThrow();
  });
});
