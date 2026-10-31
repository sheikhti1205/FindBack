import { describe, expect, it } from "vitest";
import { ApplicationAiService } from "./applicationAi";
import { NEEDLE_DESCRIPTOR, productionModelRegistry } from "./modelDescriptors";
import type { ModelDownloadDriver } from "./download/driver";

const formerlyCurated = [
  "qwen3-1.7b-dynamic-int4", "lfm2-350m-q4_0", "lfm2-700m-q4_0",
  "lfm2-1.2b-q4_0", "granite-3.3-2b-instruct-q4_0", "lfm2-vl-450m-q4_0",
  "lfm2-vl-1.6b-q4_0", "qwen3-vl-2b-instruct-q4_k_m", "lfm2.5-1.2b-q4_0",
  "lfm2.5-vl-450m-stock", "lfm2.5-vl-450m-fixb",
];

describe("upgrade cleanup, never a model catalogue", () => {
  it.each(["cact", "gguf", "litertlm"])("rediscovers old imported %s files without re-enabling acquisition", async (format) => {
    const hash = "a".repeat(64);
    const id = `imported-${hash}`;
    const file = `/private/models/${id}/${hash}/model.${format}`;
    const disk = new Map([[file, hash]]);
    const needleFile = `/private/models/${NEEDLE_DESCRIPTOR.modelId}/${NEEDLE_DESCRIPTOR.revision}/${NEEDLE_DESCRIPTOR.fileName}`;
    disk.set(needleFile, NEEDLE_DESCRIPTOR.sha256);
    let unloads = 0;
    let metadata = JSON.stringify([{ sha256: hash, bytes: 12, format, license: "Apache-2.0", url: "https://models.example.org/model" }]);
    const removed: string[] = [];
    const driver: ModelDownloadDriver = {
      rootDir: async () => "/private", supportedAbis: async () => ["arm64-v8a"],
      freeBytes: async () => 1e10, stagedSize: async () => 0, readJournalText: async () => null,
      cancelDownload: async () => {},
      readMetadata: async () => metadata, writeMetadata: async (_path, text) => { metadata = text; },
      download: async () => { throw new Error("No acquisition allowed"); },
      promoteFile: async () => { throw new Error("No promotion allowed"); },
      hashFile: async (path) => disk.get(path) ?? "",
      removeFile: async (path) => {
        removed.push(path);
        for (const key of disk.keys()) if (key === path || key.startsWith(`${path}/`)) disk.delete(key);
      },
    };
    const service = new ApplicationAiService({ android: true, driver, needle: {
      bridgeName: "needle-cact", isNeedleAvailable: async () => true,
      embeddingDimension: async () => 2, loadModel: async () => 2,
      embedNeedleTexts: async () => [[1, 0]], initTools: async () => {}, completeJson: async () => "{}",
      unload: async () => { unloads++; },
    } });
    await service.ready;
    await service.embedNeedle(["umbrella"]);
    service.selectMatchingBackend("needle");
    expect(service.registry.requireDescriptor(id).cleanupOnly).toBe(true);
    expect(service.registry.catalogue().some((d) => d.modelId === id)).toBe(false);
    expect(service.manager.statusOf(id)).toMatchObject({ download: "installed", checksumVerified: true });
    await expect(service.download(id)).rejects.toThrow(/no longer available/i);
    await service.remove(id);
    expect(removed).toContain(`/private/models/${id}`);
    expect(disk.size).toBe(1);
    expect(disk.get(needleFile)).toBe(NEEDLE_DESCRIPTOR.sha256);
    expect(unloads).toBe(0);
    expect(service.matchingBackend).toBe("needle");
    expect(service.residency.owner).toBe("needle");
    expect(JSON.parse(metadata)).toEqual([]);
    expect(service.registry.descriptorFor(id)).toBeUndefined();
  });

  it.each(formerlyCurated)("rediscovers and removes old %s bytes without an engine", async (id) => {
    const registry = productionModelRegistry();
    const descriptor = registry.requireDescriptor(id);
    expect(descriptor).toMatchObject({ cleanupOnly: true, downloadable: false, importable: false, taskRoles: [] });
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(registry.catalogue().some((model) => model.modelId === id)).toBe(false);
    const disk = new Map<string, string>();
    const removed: string[] = [];
    const root = "/private/models";
    const driver: ModelDownloadDriver = {
      rootDir: async () => root, supportedAbis: async () => ["arm64-v8a"],
      freeBytes: async () => 1e10, stagedSize: async () => 0,
      readJournalText: async () => null, cancelDownload: async () => {},
      download: async () => { throw new Error("Retired artifacts cannot be acquired"); },
      promoteFile: async () => { throw new Error("No promotion during cleanup"); },
      hashFile: async (path) => disk.get(path) ?? "",
      removeFile: async (path) => {
        removed.push(path);
        for (const key of disk.keys()) if (key === path || key.startsWith(`${path}/`)) disk.delete(key);
      },
    };
    const installed = `${root}/models/${id}/${descriptor.revision}/${descriptor.fileName}`;
    disk.set(installed, descriptor.sha256);
    for (const file of descriptor.companions ?? []) {
      disk.set(`${root}/models/${id}/${descriptor.revision}/${file.fileName}`, file.sha256);
    }
    const service = new ApplicationAiService({ android: true, driver });
    await service.ready;
    expect(service.manager.statusOf(id)).toMatchObject({ download: "installed", checksumVerified: true });
    await expect(service.download(id)).rejects.toThrow(/no longer available/i);
    await service.remove(id);
    expect(removed).toContain(`${root}/models/${id}`);
    expect(disk.size).toBe(0);
    expect(service.manager.statusOf(id)?.download).toBe("not-installed");
  });
});
