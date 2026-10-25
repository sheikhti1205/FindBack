import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ModelDownloadDriver } from "./download/driver";
import { NEEDLE_MODEL_ID } from "./needle/embedder";
import { productionModelRegistry } from "./modelDescriptors";

// Only the Capacitor boundary is replaced. The real default service, Needle
// bridge and registry run; every attempted native plugin dispatch is observed.
const native = vi.hoisted(() => ({ calls: [] as string[], loaded: false }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
  registerPlugin: (name: string) => {
    native.calls.push(name);
    if (name !== "FindbackNeedle") throw new Error(`Retired plugin dispatched: ${name}`);
    return {
      isNeedleAvailable: async () => ({ available: native.loaded }),
      loadNeedleModel: async () => { native.loaded = true; return { ready: true, dimension: 2 }; },
      embeddingDimension: async () => ({ dimension: 2 }),
      embedNeedleTexts: async ({ texts }: { texts: string[] }) => ({ vectors: texts.map(() => [1, 0]) }),
      initNeedleTools: async () => ({}),
      completeNeedleJson: async () => ({ output: JSON.stringify({ function_calls: [{ name: "search_filters", arguments: { query: "umbrella" } }] }) }),
      unloadNeedleModel: async () => { native.loaded = false; },
    };
  },
}));

import { ApplicationAiService } from "./applicationAi";

function storedModels() {
  native.calls.length = 0; native.loaded = false;
  const disk = new Map<string, string>();
  const registry = productionModelRegistry();
  for (const d of registry.descriptors.filter(d => d.cleanupOnly || d.modelId === NEEDLE_MODEL_ID))
    disk.set(`/private/models/${d.modelId}/${d.revision}/${d.fileName}`, d.sha256);
  const driver: ModelDownloadDriver = {
    rootDir: async () => "/private", supportedAbis: async () => ["arm64-v8a"], freeBytes: async () => 2e9,
    stagedSize: async () => 0, readJournalText: async () => null,
    hashFile: async path => { if (!disk.has(path)) throw new Error("missing"); return disk.get(path)!; },
    removeFile: async path => { disk.delete(path); },
    cancelDownload: async () => {},
    download: async () => { throw new Error("Must not acquire bytes"); },
    promoteFile: async () => { throw new Error("Must not acquire bytes"); },
  };
  return { disk, driver, registry };
}

describe("retired bridges actually absent from the default Android service", () => {
  it("resets without registering rejected native plugins", async () => {
    const p = storedModels();
    const service = new ApplicationAiService({ android: true, driver: p.driver }); await service.ready;
    await service.resetForAccount();
    expect(native.calls).not.toContain("FindbackSmolVlm");
    expect(native.calls).not.toContain("FindbackQwenText");
    expect(native.calls).not.toContain("FindbackLlama");
    expect(new Set(native.calls)).toEqual(new Set(["FindbackNeedle"]));
  });

  it("removes old installs without requiring a retired vision or text bridge", async () => {
    const p = storedModels();
    const service = new ApplicationAiService({ android: true, driver: p.driver }); await service.ready;
    for (const d of p.registry.descriptors.filter(d => d.cleanupOnly)) {
      await service.remove(d.modelId);
      expect(p.disk.has(`/private/models/${d.modelId}/${d.revision}/${d.fileName}`)).toBe(false);
    }
    expect(service.manager.statusOf(NEEDLE_MODEL_ID)?.checksumVerified).toBe(true);
    expect(native.calls).toEqual([]);
  });

  it("keeps saved Chat refusal usable with no vision bridge and never resolves old image bytes", async () => {
    const p = storedModels();
    const service = new ApplicationAiService({ android: true, driver: p.driver }); await service.ready;
    const adapter = service.offlineAdapter(async () => { throw new Error("Must not read images"); });
    // Installed Needle remains available for tools/embeddings, not Chat.
    const models = await adapter.listModels!();
    expect(models.map(model => model.id)).toEqual([NEEDLE_MODEL_ID]);
    expect(models[0]?.qualifiedRoles).toEqual(["tools", "embeddings"]);
    const events = [];
    for await (const event of adapter.complete({
      selection: { accountId: "u", provider: "offline", modelId: "qwen3-0.6b-dynamic-int4", mode: "free-only" },
      task: "app-help", policyVersion: "p", knowledgeVersion: "k", recentTurns: [],
      currentText: "help", approvedImageIds: ["old-image"], authorizedResultIds: [],
      maxOutputTokens: 64, signal: new AbortController().signal,
    })) events.push(event);
    expect(events).toEqual([
      { kind: "error", attempt: 1, code: "model_retired", retryable: false, message: "On-device Chat is no longer available. Choose a cloud provider in Settings." },
      { kind: "done", attempt: 1, stopReason: "error" },
    ]);
    expect(native.calls).toEqual([]);
  });

  it("serves retained structured search and embeddings through the real Needle bridge after reset", async () => {
    const p = storedModels();
    const service = new ApplicationAiService({ android: true, driver: p.driver }); await service.ready;
    for (let pass = 0; pass < 2; pass++) {
      const result = await service.route("extract-search-filters", { prompt: "umbrella" }, { traceId: "retained" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatchObject({ fields: { query: "umbrella" } });
        expect(result.provenance).toMatchObject({ modelId: NEEDLE_MODEL_ID, runtimeId: "needle-cact" });
      }
      expect(await service.embedNeedle(["umbrella"])).toEqual([[1, 0]]);
      await service.resetForAccount();
      expect(service.manager.statusOf(NEEDLE_MODEL_ID)?.checksumVerified).toBe(true);
    }
    expect(new Set(native.calls)).toEqual(new Set(["FindbackNeedle"]));
  });

  it("returns absent legacy vision facts rather than dispatching a rejected probe", async () => {
    const p = storedModels();
    const service = new ApplicationAiService({ android: true, driver: p.driver }); await service.ready;
    expect(await service.facts()).toBeUndefined();
    expect(native.calls).toEqual([]);
  });

  it("keeps failed old-import cleanup retryable with every retired bridge absent", async () => {
    const p = storedModels();
    const sha = "b".repeat(64), id = `imported-${sha}`;
    let metadata = JSON.stringify([{ sha256: sha, bytes: 128, format: "litertlm", modality: "vision", license: "Apache-2.0" }]);
    const path = `/private/models/${id}/${sha}/model.litertlm`;
    p.disk.set(path, sha);
    let fail = true;
    const driver: ModelDownloadDriver = { ...p.driver,
      readMetadata: async () => metadata,
      writeMetadata: async (_path, text) => { metadata = text; },
      removeFile: async file => { if (fail) throw new Error("disk unavailable"); await p.driver.removeFile(file); },
    };
    const service = new ApplicationAiService({ android: true, driver }); await service.ready;
    await expect(service.remove(id)).rejects.toThrow();
    expect(service.busy(id)).toBe(false);
    expect(p.disk.has(path)).toBe(true);
    expect(JSON.parse(metadata)).toHaveLength(1);
    expect(service.registry.requireDescriptor(id)).toMatchObject({ cleanupOnly: true, capabilities: ["vision"] });
    fail = false;
    await service.remove(id);
    expect(p.disk.has(path)).toBe(false);
    expect(JSON.parse(metadata)).toEqual([]);
    expect(service.registry.descriptorFor(id)).toBeUndefined();
    expect(service.manager.statusOf(NEEDLE_MODEL_ID)?.checksumVerified).toBe(true);
    expect(native.calls).toEqual([]);
  });

  it("refuses acquisition and measurement with absent retired plugins", async () => {
    const p = storedModels();
    const service = new ApplicationAiService({ android: true, driver: p.driver }); await service.ready;
    for (const d of p.registry.descriptors.filter(d => d.cleanupOnly)) {
      await expect(service.download(d.modelId)).rejects.toThrow(/no longer available/i);
      await expect(service.evaluate(d.modelId, { optIn: true, prompt: "help" })).rejects.toThrow(/no longer available/i);
    }
    await expect(service.measure("cpu")).rejects.toThrow(/no vision model/i);
    expect(native.calls).toEqual([]);
  });
});

it("registers retained native owners but no rejected generative plugin in MainActivity", () => {
  const activity = readFileSync(new URL("../../../android/app/src/main/java/com/findback/app/MainActivity.java", import.meta.url), "utf8");
  for (const name of ["FindbackNeedle", "EmbeddingPlugin", "ModelDownloadPlugin", "FindBackDiagPlugin"])
    expect(activity).toContain(`registerPlugin(${name}.class)`);
  for (const name of ["QwenTextPlugin", "FindbackLlama", "SmolVlmPlugin"])
    expect(activity).not.toContain(`registerPlugin(${name}.class)`);
});
