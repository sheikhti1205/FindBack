import { describe, expect, it } from "vitest";
import {
  deriveLibraryRuntimeState,
  libraryRoleForEntry,
} from "./libraryRuntimeState";
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
    downloadBytes: 360823868,
    installedBytes: 360822960,
    sha256: "41e11106a57ae750f61d992ab195f90b9f7bc58c39009b5dac0ce9d1c60a366e",
    minFreeRamMb: 1536,
    recommendedFreeRamMb: 2560,
    ramRequirementSource: "CONSERVATIVE_ESTIMATE",
    verificationStatus: "VERIFIED",
    description: "Test entry.",
    supportedCapabilities: ["report-from-photo"],
    upstreamRepo: "litert-community/SmolVLM2-500M",
    provenance: [{ kind: "REPO_EVIDENCE", ref: "x", note: "test" }],
    distribution: {
      repo: "sheikhti1205/FindBack-Models",
      tag: "models-2026-09-22-v1",
      asset: "smolvlm2-500m-litert-int4.fbmodel",
      bytes: 360823868,
      sha256: "41e11106a57ae750f61d992ab195f90b9f7bc58c39009b5dac0ce9d1c60a366e",
      state: "UNPUBLISHED",
      parts: null,
    },
    ...overrides,
  };
}

function qwenEntry(overrides: Partial<ModelCatalogueEntry> = {}): ModelCatalogueEntry {
  return entry({
    id: "qwen3-0.6b-litert-dynamic-int4",
    displayName: "Qwen3 0.6B (LiteRT, dynamic int4)",
    category: "text",
    role: "chat-text",
    revision: "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76",
    downloadBytes: 344672713,
    installedBytes: 344671744,
    sha256: "8a8a2d5747aa804c8f39e79658d2b3e5962f0451e0e16571b6bdb9dcd8205821",
    installedSha256:
      "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
    minFreeRamMb: 1280,
    recommendedFreeRamMb: 2560,
    verificationStatus: "SUPPORTED_UNVERIFIED",
    supportedCapabilities: ["text-generation"],
    upstreamRepo: "litert-community/Qwen3-0.6B",
    distribution: {
      repo: "sheikhti1205/FindBack-Models",
      tag: "models-2026-09-22-v1",
      asset: "qwen3-0.6b-litert-dynamic-int4.fbmodel",
      bytes: 344672713,
      sha256: "8a8a2d5747aa804c8f39e79658d2b3e5962f0451e0e16571b6bdb9dcd8205821",
      state: "UNPUBLISHED",
      parts: null,
    },
    ...overrides,
  });
}

describe("libraryRoleForEntry", () => {
  it("maps report-from-photo to IMAGE and chat-text to TEXT", () => {
    expect(libraryRoleForEntry(entry())).toBe("IMAGE");
    expect(libraryRoleForEntry(qwenEntry())).toBe("TEXT");
  });

  it("maps catalog references to INFORMATION_ONLY", () => {
    expect(
      libraryRoleForEntry(
        entry({
          id: "gemma-3n-e2b-it-litert-int4",
          role: "catalog-reference",
          catalogOnly: true,
        }),
      ),
    ).toBe("INFORMATION_ONLY");
  });
});

describe("deriveLibraryRuntimeState (frozen role-aware contract)", () => {
  it("drives IMAGE from the image lifecycle without touching Qwen", () => {
    const ready = deriveLibraryRuntimeState(entry(), {
      isActive: false,
      imageState: "READY_GPU",
    });
    expect(ready.role).toBe("IMAGE");
    expect(ready.installed).toBe(true);
    expect(ready.verified).toBe(true);
    expect(ready.ready).toBe(true);
    expect(ready.canSelfTest).toBe(true);
    expect(ready.canDelete).toBe(true);

    const unverified = deriveLibraryRuntimeState(entry(), {
      isActive: false,
      imageState: "INSTALLED_UNVERIFIED",
    });
    expect(unverified.installed).toBe(true);
    expect(unverified.verified).toBe(false);
    expect(unverified.ready).toBe(false);
  });

  it("keeps UNPUBLISHED IMAGE downloadable=false but importable with a pin", () => {
    const state = deriveLibraryRuntimeState(entry(), {
      isActive: false,
      imageState: "NOT_INSTALLED",
    });
    expect(state.canDownload).toBe(false);
    expect(state.canImport).toBe(true);
    expect(state.canExport).toBe(true);
  });

  it("drives TEXT from the Qwen lifecycle, never from VlmModelId", () => {
    const ready = deriveLibraryRuntimeState(qwenEntry(), {
      isActive: false,
      textInstalled: true,
      textReady: true,
      textRuntimePresent: true,
    });
    expect(ready.role).toBe("TEXT");
    expect(ready.installed).toBe(true);
    expect(ready.verified).toBe(true);
    expect(ready.ready).toBe(true);
    // Unpublished stays non-downloadable even when the text runtime exists.
    expect(ready.canDownload).toBe(false);
    expect(ready.canImport).toBe(true);
    expect(ready.canExport).toBe(true);
  });

  it("keeps TEXT not-ready without TEXT_READY proof", () => {
    const state = deriveLibraryRuntimeState(qwenEntry(), {
      isActive: false,
      textInstalled: true,
      textReady: false,
      textRuntimePresent: true,
    });
    expect(state.installed).toBe(true);
    expect(state.ready).toBe(false);
  });

  it("keeps information-only entries static with no actions", () => {
    const state = deriveLibraryRuntimeState(
      entry({
        id: "gemma-3n-e2b-it-litert-int4",
        role: "catalog-reference",
        catalogOnly: true,
      }),
      { isActive: false },
    );
    expect(state.role).toBe("INFORMATION_ONLY");
    expect(state.installed).toBe(false);
    expect(state.verified).toBe(false);
    expect(state.ready).toBe(false);
    expect(state.active).toBe(false);
    expect(state.canImport).toBe(false);
    expect(state.canDownload).toBe(false);
    expect(state.canDelete).toBe(false);
    expect(state.canExport).toBe(false);
    expect(state.canSelfTest).toBe(false);
  });

  it("exposes exactly the frozen shape", () => {
    const state = deriveLibraryRuntimeState(entry(), {
      isActive: false,
      imageState: "NOT_INSTALLED",
    });
    expect(state.entryId).toBe("smolvlm2-500m-litert-int4");
    expect(Object.keys(state).sort()).toEqual(
      [
        "active",
        "canDelete",
        "canDownload",
        "canExport",
        "canImport",
        "canSelfTest",
        "entryId",
        "installed",
        "ready",
        "role",
        "verified",
      ].sort(),
    );
  });
});
