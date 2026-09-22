import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogueEntry } from "./catalogueTypes";
import { sha256BytesHex, type DownloadTransport } from "./modelTransfers";
import { MemoryTransferStore } from "./transferStore";
import {
  QWEN_TEXT_BRIDGE_MODEL_ID,
  QWEN_TEXT_ENTRY_ID,
  type TextGenerationBridge,
} from "./textRuntime";
import {
  activateQwenText,
  deriveQwenLifecycleStatus,
  downloadQwenToStore,
  isQwenOwnedRelativePath,
  isQwenReadyForText,
  isQwenTextRoleActive,
  isTextReadySelfTest,
  partitionQwenOwned,
  qwenDownloadUrl,
  qwenExportArgs,
  qwenImportArgs,
  qwenOwnedRelativePaths,
  shellTextSeamsFromBridgeStatus,
  shippedQwenEntry,
  signalsFromBridgeStatus,
  TEXT_READY_STATE,
} from "./qwenLifecycle";

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
    downloadBytes: 64,
    installedBytes: 344671744,
    sha256:
      "8a8a2d5747aa804c8f39e79658d2b3e5962f0451e0e16571b6bdb9dcd8205821",
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
    // Mirrors the shipped catalogue: prepared but not published.
    distribution: {
      repo: "sheikhti1205/FindBack-Models",
      tag: "models-2026-09-22-v1",
      asset: "qwen3-0.6b-litert-dynamic-int4.fbmodel",
      bytes: 64,
      sha256:
        "8a8a2d5747aa804c8f39e79658d2b3e5962f0451e0e16571b6bdb9dcd8205821",
      state: "UNPUBLISHED",
      parts: null,
    },
    ...overrides,
  };
}

/** Fixture entry with a PUBLISHED distribution for download success paths. */
function publishedQwenEntry(
  overrides: Partial<ModelCatalogueEntry> = {},
): ModelCatalogueEntry {
  const entry = qwenEntry(overrides);
  return {
    ...entry,
    distribution:
      entry.distribution == null
        ? null
        : { ...entry.distribution, state: "PUBLISHED" },
  };
}

function fixtureBytes(): Uint8Array {
  const out = new Uint8Array(64);
  for (let i = 0; i < out.length; i++) out[i] = (i * 7 + 3) & 0xff;
  return out;
}

function fakeTransport(data: Uint8Array): DownloadTransport {
  return {
    download: async (url, offset, onChunk) => {
      void url;
      let sent = offset;
      while (sent < data.length) {
        const end = Math.min(sent + 7, data.length);
        onChunk(data.slice(sent, end));
        sent = end;
      }
      return { totalBytes: data.length };
    },
  };
}

describe("deriveQwenLifecycleStatus", () => {
  it("reports installed only when transfer validation and file presence both hold", () => {
    expect(
      deriveQwenLifecycleStatus({
        transferValidated: true,
        modelFilePresent: true,
        textReady: true,
        residentModelId: QWEN_TEXT_BRIDGE_MODEL_ID,
      }).installed,
    ).toBe(true);
  });

  it("never reports installed for a merely present file", () => {
    const status = deriveQwenLifecycleStatus({
      transferValidated: false,
      modelFilePresent: true,
      textReady: false,
      residentModelId: null,
    });
    expect(status.installed).toBe(false);
    expect(status.modelFilePresent).toBe(true);
  });

  it("never reports installed for validation without the file", () => {
    const status = deriveQwenLifecycleStatus({
      transferValidated: true,
      modelFilePresent: false,
      textReady: false,
      residentModelId: null,
    });
    expect(status.installed).toBe(false);
  });

  it("carries the frozen identity on every status", () => {
    const status = deriveQwenLifecycleStatus({
      transferValidated: false,
      modelFilePresent: false,
      textReady: false,
      residentModelId: null,
    });
    expect(status.entryId).toBe(QWEN_TEXT_ENTRY_ID);
    expect(status.modelId).toBe(QWEN_TEXT_BRIDGE_MODEL_ID);
  });
});

describe("isQwenReadyForText", () => {
  it("requires both validated install and TEXT_READY proof", () => {
    const ready = {
      transferValidated: true,
      modelFilePresent: true,
      textReady: true,
      residentModelId: QWEN_TEXT_BRIDGE_MODEL_ID as typeof QWEN_TEXT_BRIDGE_MODEL_ID | null,
    };
    expect(isQwenReadyForText(deriveQwenLifecycleStatus(ready))).toBe(true);
    expect(
      isQwenReadyForText(
        deriveQwenLifecycleStatus({ ...ready, textReady: false }),
      ),
    ).toBe(false);
    expect(
      isQwenReadyForText(
        deriveQwenLifecycleStatus({ ...ready, modelFilePresent: false }),
      ),
    ).toBe(false);
  });
});

describe("isTextReadySelfTest", () => {
  it("accepts only ready plus the TEXT_READY state", () => {
    expect(
      isTextReadySelfTest({ ready: true, state: TEXT_READY_STATE }),
    ).toBe(true);
    expect(isTextReadySelfTest({ ready: true, state: "TEXT_UNAVAILABLE" })).toBe(
      false,
    );
    expect(isTextReadySelfTest({ ready: false, state: TEXT_READY_STATE })).toBe(
      false,
    );
  });
});

describe("isQwenTextRoleActive", () => {
  it("matches only the qualified entry id", () => {
    expect(isQwenTextRoleActive(QWEN_TEXT_ENTRY_ID)).toBe(true);
    expect(isQwenTextRoleActive("smolvlm2-500m-litert-int4")).toBe(false);
    expect(isQwenTextRoleActive(null)).toBe(false);
  });
});

describe("activateQwenText", () => {
  function bridge(): TextGenerationBridge {
    return {
      generateText: vi.fn(async (request) => ({
        text: "hi",
        modelId: request.modelId,
      })),
      cancelInference: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
  }

  it("stays blocked when the runtime is absent", async () => {
    const result = await activateQwenText(bridge(), qwenEntry(), {
      currentResidentId: null,
      availableFreeRamMb: 4096,
      advancedConfirmed: true,
      textRuntimePresent: false,
      runtimeReady: false,
    });
    expect(result.ok).toBe(false);
  });

  it("activates the pin-verified entry with the ready proof", async () => {
    const entry = qwenEntry();
    const result = await activateQwenText(bridge(), entry, {
      currentResidentId: null,
      availableFreeRamMb: 4096,
      advancedConfirmed: true,
      textRuntimePresent: true,
      runtimeReady: true,
    });
    expect(result).toEqual({ ok: true, alreadyActive: false });
  });
});

describe("downloadQwenToStore", () => {
  it("downloads, verifies, and commits the qualified entry", async () => {
    const data = fixtureBytes();
    const entry = publishedQwenEntry({
      downloadBytes: data.length,
      installedBytes: data.length,
      sha256: sha256BytesHex(data),
    });
    const store = new MemoryTransferStore();
    const result = await downloadQwenToStore(entry, fakeTransport(data), store, {
      availableFreeRamMb: 4096,
      advancedConfirmed: true,
    });
    expect(result.ok).toBe(true);
    expect(store.installedBytes(entry.id)).toBe(data.length);
  });

  it("refuses network download while the distribution is unpublished", async () => {
    const data = fixtureBytes();
    const entry = qwenEntry({
      downloadBytes: data.length,
      installedBytes: data.length,
      sha256: sha256BytesHex(data),
    });
    const transport = fakeTransport(data);
    const download = vi.spyOn(transport, "download");
    const store = new MemoryTransferStore();
    const result = await downloadQwenToStore(entry, transport, store, {
      availableFreeRamMb: 4096,
      advancedConfirmed: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_PUBLISHED");
    expect(download).not.toHaveBeenCalled();
    expect(store.installedBytes(entry.id)).toBe(null);
  });

  it("refuses entries without a pinned release asset", async () => {
    const store = new MemoryTransferStore();
    const result = await downloadQwenToStore(
      qwenEntry({ distribution: null, sha256: null }),
      fakeTransport(fixtureBytes()),
      store,
      { availableFreeRamMb: 4096, advancedConfirmed: true },
    );
    expect(result.ok).toBe(false);
    expect(store.installedBytes(qwenEntry().id)).toBe(null);
  });

  it("rejects a tampered artifact and stages nothing as installed", async () => {
    const data = fixtureBytes();
    const tampered = data.slice();
    tampered[0] = ((tampered[0] ?? 0) + 1) & 0xff;
    const entry = publishedQwenEntry({
      downloadBytes: data.length,
      installedBytes: data.length,
      sha256: sha256BytesHex(data),
    });
    const store = new MemoryTransferStore();
    const result = await downloadQwenToStore(
      entry,
      fakeTransport(tampered),
      store,
      { availableFreeRamMb: 4096, advancedConfirmed: true },
    );
    expect(result.ok).toBe(false);
    expect(store.installedBytes(entry.id)).toBe(null);
  });
});

describe("qwenDownloadUrl", () => {
  it("builds the pinned release URL for the qualified entry only", () => {
    expect(qwenDownloadUrl(publishedQwenEntry())).toBe(
      "https://github.com/sheikhti1205/FindBack-Models/releases/download/models-2026-09-22-v1/qwen3-0.6b-litert-dynamic-int4.fbmodel",
    );
    expect(qwenDownloadUrl(publishedQwenEntry({ id: "other-entry" }))).toBe(null);
  });

  it("withholds the URL while the distribution is unpublished", () => {
    expect(qwenDownloadUrl(qwenEntry())).toBe(null);
  });
});

describe("qwenImportArgs", () => {
  it("pins the expected hash from the shipped catalogue entry", () => {
    const result = qwenImportArgs(qwenEntry(), "content://pkg/model.fbmodel");
    expect(result).toEqual({
      ok: true,
      args: {
        entryId: QWEN_TEXT_ENTRY_ID,
        sourceUri: "content://pkg/model.fbmodel",
        expectedSha256:
          "8a8a2d5747aa804c8f39e79658d2b3e5962f0451e0e16571b6bdb9dcd8205821",
      },
    });
  });

  it("refuses foreign entries and missing pins fail-closed", () => {
    expect(qwenImportArgs(qwenEntry({ id: "other" }), "content://x").ok).toBe(
      false,
    );
    expect(
      qwenImportArgs(qwenEntry({ distribution: null, sha256: null }), "content://x")
        .ok,
    ).toBe(false);
    expect(qwenImportArgs(qwenEntry(), "").ok).toBe(false);
  });
});

describe("qwenExportArgs", () => {
  it("addresses the qualified entry", () => {
    expect(qwenExportArgs("content://out/model.fbmodel")).toEqual({
      entryId: QWEN_TEXT_ENTRY_ID,
      destUri: "content://out/model.fbmodel",
    });
  });
});

describe("delete-exactness", () => {
  it("owns exactly the qualified weights file", () => {
    const entry = qwenEntry();
    expect(qwenOwnedRelativePaths(entry)).toEqual([
      "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
    ]);
    expect(
      isQwenOwnedRelativePath(entry, "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm"),
    ).toBe(true);
    expect(isQwenOwnedRelativePath(entry, "SmolVLM2-500M.litertlm")).toBe(false);
  });

  it("partitions sibling files as foreign so delete leaves them untouched", () => {
    const entry = qwenEntry();
    const { owned, foreign } = partitionQwenOwned(entry, [
      "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
      "SmolVLM2-500M.litertlm",
      "tokenizer.model",
      "checksums.json",
    ]);
    expect(owned).toEqual(["Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm"]);
    expect(foreign).toEqual([
      "SmolVLM2-500M.litertlm",
      "tokenizer.model",
      "checksums.json",
    ]);
  });

  it("owns nothing for foreign entries", () => {
    expect(qwenOwnedRelativePaths(qwenEntry({ id: "other" }))).toEqual([]);
  });
});

describe("signalsFromBridgeStatus", () => {
  it("maps the full native status read", () => {
    expect(
      signalsFromBridgeStatus({
        modelId: QWEN_TEXT_BRIDGE_MODEL_ID,
        ready: true,
        nativeRunning: false,
        backend: "gpu",
        modelFilePresent: true,
        installed: true,
        textReady: true,
        residentModelId: QWEN_TEXT_BRIDGE_MODEL_ID,
      }),
    ).toEqual({
      transferValidated: true,
      modelFilePresent: true,
      textReady: true,
      residentModelId: QWEN_TEXT_BRIDGE_MODEL_ID,
    });
  });

  it("fails closed when lifecycle fields are absent", () => {
    expect(
      signalsFromBridgeStatus({
        modelId: QWEN_TEXT_BRIDGE_MODEL_ID,
        ready: false,
        nativeRunning: false,
        backend: "gpu",
        modelFilePresent: true,
      }),
    ).toEqual({
      transferValidated: false,
      modelFilePresent: true,
      textReady: false,
      residentModelId: null,
    });
  });

  it("never accepts a foreign resident id", () => {
    const signals = signalsFromBridgeStatus({
      modelId: QWEN_TEXT_BRIDGE_MODEL_ID,
      ready: true,
      nativeRunning: false,
      backend: "gpu",
      modelFilePresent: true,
      installed: true,
      textReady: true,
      residentModelId: "smolvlm2-500m",
    });
    expect(signals.residentModelId).toBe(null);
  });
});

describe("shellTextSeamsFromBridgeStatus", () => {
  it("fails closed on a missing status read", () => {
    expect(shellTextSeamsFromBridgeStatus(null)).toEqual({
      textInstalled: false,
      textReady: false,
    });
    expect(shellTextSeamsFromBridgeStatus(undefined)).toEqual({
      textInstalled: false,
      textReady: false,
    });
  });

  it("projects installed and ready, never file presence alone", () => {
    expect(
      shellTextSeamsFromBridgeStatus({
        modelId: QWEN_TEXT_BRIDGE_MODEL_ID,
        ready: true,
        nativeRunning: false,
        backend: "gpu",
        modelFilePresent: true,
        installed: true,
        textReady: true,
      }),
    ).toEqual({ textInstalled: true, textReady: true });
    expect(
      shellTextSeamsFromBridgeStatus({
        modelId: QWEN_TEXT_BRIDGE_MODEL_ID,
        ready: false,
        nativeRunning: false,
        backend: "gpu",
        modelFilePresent: true,
        installed: true,
        textReady: false,
      }),
    ).toEqual({ textInstalled: true, textReady: false });
    expect(
      shellTextSeamsFromBridgeStatus({
        modelId: QWEN_TEXT_BRIDGE_MODEL_ID,
        ready: false,
        nativeRunning: false,
        backend: "gpu",
        modelFilePresent: true,
        installed: false,
        textReady: false,
      }),
    ).toEqual({ textInstalled: false, textReady: false });
  });
});

describe("shippedQwenEntry", () => {
  it("resolves the qualified entry from the shipped catalogue", () => {
    expect(shippedQwenEntry()?.id).toBe(QWEN_TEXT_ENTRY_ID);
  });
});
